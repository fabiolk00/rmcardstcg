import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do achado 🟡 "Reconcile re-busca getOrderById por pedido pago" (ITEM #1):
// applyPaymentStatusTx/setOrderPaymentStatus passam a DEVOLVER o Order COMPLETO
// (com itens) ja com paymentStatus = novo status, lido na MESMA query inicial.
// Assim webhook e reconcile montam o e-mail SEM um getOrderById extra por pedido
// pago.
//
// Cobrimos:
//   1. pagamento NOVO (pending -> paid): result.order vem preenchido, com
//      paymentStatus="paid" (refletindo o status NOVO, embora o row tenha sido
//      lido ANTES do compare-and-swap) e com os itens do pedido.
//   2. reprocessamento (paid -> paid, changed=false): result.order continua vindo
//      (idempotente) — o consumidor so envia e-mail quando changed, mas o shape
//      e estavel.
//   3. CONTAGEM de queries: a transacao de pagamento NAO faz leitura extra alem da
//      unica findUnique (sem o getOrderById de antes). Medido no nivel do pg.Pool.
//
// Opt-in via TEST_DATABASE_URL (Postgres descartavel e alcancavel). Sem ela a
// suite e PULADA. Ver tests/nplusone/README.md para subir o banco.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  "pagamento — applyPaymentStatusTx devolve o Order p/ o e-mail (sem getOrderById extra)",
  () => {
    // Tipos frouxos: client gerado + funcoes de dados carregados dinamicamente, e
    // so quando ha DB (lib/db le DATABASE_URL no load).
    let prisma: any;
    let orders: any;
    let counting: any;
    let countingPrisma: any;

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      prisma = (await import("../../lib/db")).prisma;
      orders = await import("../../lib/data/orders");

      // Pool instrumentado para a prova de contagem de round-trips (mesmo harness
      // de tests/nplusone): conta as idas reais ao Postgres da transacao.
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const { PrismaClient } = await import("../../lib/generated/prisma/client");
      counting = (await import("../../scripts/count-queries")).makeCountingPool(TEST_DATABASE_URL!);
      countingPrisma = new PrismaClient({ adapter: new PrismaPg(counting.pool) });
    });

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
      if (countingPrisma) await countingPrisma.$disconnect();
      if (counting) await counting.pool.end();
    });

    async function seedProduct(stock: number, reserved = 0): Promise<string> {
      const id = randomUUID();
      const tag = id.slice(0, 8);
      await prisma.product.create({
        data: {
          id,
          slug: `p-${tag}`,
          name: `Test ${tag}`,
          category: "Tin",
          sku: `SKU-${tag}`,
          priceCents: 1000,
          imageUrl: "/x.svg",
          description: "test",
          stock,
          reserved,
        },
      });
      return id;
    }

    async function seedOrder(opts: {
      productId: string;
      qty: number;
      asaasPaymentId: string;
      paymentStatus: "pending" | "paid";
      stockReserved: boolean;
      stockCommitted: boolean;
    }): Promise<number> {
      const order = await prisma.order.create({
        data: {
          userId: "guest",
          customerName: "T",
          customerEmail: "t@t.com",
          customerPhone: "0",
          addressCep: "0",
          addressStreet: "r",
          addressCity: "c",
          addressState: "PR",
          subtotalCents: opts.qty * 1000,
          totalCents: opts.qty * 1000,
          paymentMethod: "PIX",
          paymentStatus: opts.paymentStatus,
          asaasPaymentId: opts.asaasPaymentId,
          stockReserved: opts.stockReserved,
          stockCommitted: opts.stockCommitted,
          items: {
            create: [
              {
                productId: opts.productId,
                productName: "Test",
                quantity: opts.qty,
                unitPriceCents: 1000,
              },
            ],
          },
        },
      });
      return order.id;
    }

    it("pagamento novo (pending -> paid): result.order vem completo c/ paymentStatus='paid'", async () => {
      const productId = await seedProduct(10, 2);
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedOrder({
        productId,
        qty: 2,
        asaasPaymentId: pay,
        paymentStatus: "pending",
        stockReserved: true,
        stockCommitted: false,
      });

      const result = await orders.setOrderPaymentStatus(orderId, "paid", {
        id: pay,
        valueCents: 2000,
      });

      expect(result.found).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      // O Order p/ o e-mail vem na MESMA leitura, ja com o status NOVO.
      expect(result.order).toBeTruthy();
      expect(result.order.id).toBe(`#${orderId}`);
      expect(result.order.paymentStatus).toBe("paid");
      expect(result.order.customerEmail).toBe("t@t.com");
      expect(result.order.totalCents).toBe(2000);
      // Itens vieram juntos (sem N+1, sem leitura adicional p/ o e-mail).
      expect(result.order.items).toHaveLength(1);
      expect(result.order.items[0]).toMatchObject({ productId, quantity: 2 });
    });

    it("reprocessamento (paid -> paid): changed=false mas result.order continua vindo", async () => {
      const productId = await seedProduct(10);
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedOrder({
        productId,
        qty: 1,
        asaasPaymentId: pay,
        paymentStatus: "paid",
        stockReserved: false,
        stockCommitted: true,
      });

      const result = await orders.setOrderPaymentStatus(orderId, "paid", {
        id: pay,
        valueCents: 1000,
      });

      expect(result.found).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false); // idempotente
      expect(result.order).toBeTruthy();
      expect(result.order.paymentStatus).toBe("paid");
      expect(result.order.id).toBe(`#${orderId}`);
    });

    it("a transacao de pagamento NÃO faz getOrderById extra (uma leitura, contada no pg.Pool)", async () => {
      const productId = await seedProduct(10, 2);
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedOrder({
        productId,
        qty: 2,
        asaasPaymentId: pay,
        paymentStatus: "pending",
        stockReserved: true,
        stockCommitted: false,
      });

      // Roda applyPaymentStatusTx no client instrumentado e mede os round-trips.
      // O fluxo do e-mail consome result.order — se houvesse um getOrderById
      // pos-transacao, seriam +1 SELECT + (BEGIN/COMMIT) round-trips. Aqui o
      // consumidor nao precisa de NENHUMA query extra: result.order ja basta.
      const { result, queries } = await counting.measure(() =>
        countingPrisma.$transaction((tx: any) =>
          orders.applyPaymentStatusTx(tx, orderId, "paid", { id: pay, valueCents: 2000 }),
        ),
      );

      expect(result.order).toBeTruthy();
      expect(result.order.paymentStatus).toBe("paid");
      // A pre-correcao precisaria de uma leitura ADICIONAL (getOrderById) fora desta
      // transacao para o e-mail; agora o Order ja vem daqui. Mantemos um teto
      // generoso (<=8) que cobre BEGIN/findUnique/UPDATEs/COMMIT mas exclui um
      // segundo SELECT do pedido inteiro com seus itens.
      expect(queries).toBeLessThanOrEqual(8);
    });
  },
);

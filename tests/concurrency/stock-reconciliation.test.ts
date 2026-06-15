import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova das corridas de reconciliacao de estoque em lib/data/orders.ts (achado P0:
// billing + stock). Exercita as funcoes REAIS (setOrderPaymentStatus,
// cancelOrderAndReleaseStock) com 2 atores concorrentes contra um Postgres real.
//
// Opt-in via TEST_DATABASE_URL (Postgres descartavel e alcancavel). Sem ela a
// suite e PULADA. Ver tests/nplusone/README.md para subir o banco.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("concorrência — reconciliação de estoque (orders.ts)", () => {
  // Tipos frouxos: client gerado + funcoes de dados carregados dinamicamente, e so
  // quando ha DB (lib/db le DATABASE_URL no load).
  let prisma: any;
  let orders: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = (await import("../../lib/db")).prisma;
    orders = await import("../../lib/data/orders");
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
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

  // Discriminador DETERMINISTICO: pedido pago+committed (estoque ja baixado),
  // dois refunds/chargebacks simultaneos. restockUnits nao tem guard de coluna,
  // entao o codigo antigo (decisao por snapshot lido sem lock) repoe DUAS vezes.
  // O CAS no proprio pedido serializa: repoe exatamente uma vez.
  it("refund concorrente NÃO repõe estoque em dobro", async () => {
    // Repete para flushar o escalonamento: a janela (ambos leem committed=true
    // antes de qualquer commit) nao ocorre em toda execucao. No codigo antigo,
    // alguma iteracao reporia 2x (stock=12). Com o CAS, sempre 1x (stock=10).
    for (let i = 0; i < 60; i += 1) {
      const productId = await seedProduct(8); // 8 = (10 baixados de 2)
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedOrder({
        productId,
        qty: 2,
        asaasPaymentId: pay,
        paymentStatus: "paid",
        stockReserved: false,
        stockCommitted: true,
      });

      const ref = { id: pay, valueCents: null };
      await Promise.all([
        orders.setOrderPaymentStatus(orderId, "cancelled", ref),
        orders.setOrderPaymentStatus(orderId, "cancelled", ref),
      ]);

      const product = await prisma.product.findUnique({ where: { id: productId } });
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(product.stock).toBe(10); // 8 + 2, reposto UMA vez (nunca 12)
      expect(product.reserved).toBe(0);
      expect(order.stockCommitted).toBe(false);
    }
  });

  // Corrida central do achado: cron expira/estorna enquanto o webhook confirma o
  // pagamento. O invariante deve valer SEMPRE: nunca "pago sem baixa de estoque".
  it("cron-release x webhook-paid: nunca 'pago sem baixa de estoque'", async () => {
    for (let i = 0; i < 60; i += 1) {
      const productId = await seedProduct(10, 2); // 2 reservados
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedOrder({
        productId,
        qty: 2,
        asaasPaymentId: pay,
        paymentStatus: "pending",
        stockReserved: true,
        stockCommitted: false,
      });

      await Promise.all([
        orders.cancelOrderAndReleaseStock(orderId),
        orders.setOrderPaymentStatus(orderId, "paid", { id: pay, valueCents: 2000 }),
      ]);

      const product = await prisma.product.findUnique({ where: { id: productId } });
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(product.reserved).toBe(0); // reserva sempre resolvida
      if (order.paymentStatus === "paid") {
        expect(product.stock).toBe(8); // baixou
        expect(order.stockCommitted).toBe(true);
      } else {
        expect(order.paymentStatus).toBe("cancelled");
        expect(product.stock).toBe(10); // reserva estornada, estoque intacto
        expect(order.stockCommitted).toBe(false);
      }
    }
  });
});

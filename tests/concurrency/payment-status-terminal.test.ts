import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regressao (achado do qa-gate, residual da reconciliacao d78f2bb): um pedido
// CANCELADO e terminal e NUNCA deve ser ressuscitado para 'paid' por um evento de
// pagamento atrasado. applyPaymentStatusTx fazia o CAS de status com
//   WHERE payment_status = <valor recem-lido>
// entao, se o cron (cancelOrderAndReleaseStock) ou o expire_overdue cancelava +
// estornava ANTES do webhook ler, o webhook lia 'cancelled' e o CAS
//   UPDATE ... SET 'paid' WHERE payment_status = 'cancelled'
// PASSAVA, deixando "pago sem baixa de estoque" (reserved ja estornado => o
// reconcile de 'paid' nao baixa). A correcao bloqueia a transicao terminal.
//
// A ressurreicao e DETERMINISTICA (nao precisa de corrida): basta um pedido ja
// cancelado receber 'paid'. Opt-in via TEST_DATABASE_URL.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  "applyPaymentStatusTx — máquina de estados (transições inválidas rejeitadas)",
  () => {
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

    async function seedCancelledOrder(
      productId: string,
      qty: number,
      pay: string,
    ): Promise<number> {
      // Estado pos-cancelamento/estorno: cancelled, sem reserva, sem commit.
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
          subtotalCents: qty * 1000,
          totalCents: qty * 1000,
          paymentMethod: "PIX",
          paymentStatus: "cancelled",
          asaasPaymentId: pay,
          stockReserved: false,
          stockCommitted: false,
          items: {
            create: [{ productId, productName: "Test", quantity: qty, unitPriceCents: 1000 }],
          },
        },
      });
      return order.id;
    }

    it("cancelled -> paid é rejeitado e NÃO baixa estoque", async () => {
      const productId = await seedProduct(10, 0);
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedCancelledOrder(productId, 2, pay);

      const result = await orders.setOrderPaymentStatus(orderId, "paid", {
        id: pay,
        valueCents: 2000,
      });

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      const product = await prisma.product.findUnique({ where: { id: productId } });

      expect(order.paymentStatus).toBe("cancelled"); // permanece terminal (não ressuscita)
      expect(order.stockCommitted).toBe(false);
      expect(product.stock).toBe(10); // nada baixado
      expect(result.found).toBe(true);
      expect(result.ok).toBe(false); // transição rejeitada
    });

    it("cancelled -> cancelled continua no-op idempotente", async () => {
      const productId = await seedProduct(10, 0);
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedCancelledOrder(productId, 2, pay);

      const result = await orders.setOrderPaymentStatus(orderId, "cancelled", {
        id: pay,
        valueCents: null,
      });
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order.paymentStatus).toBe("cancelled");
      expect(result.ok).toBe(true);
      expect(result.changed).toBe(false);
    });

    // Seed genérico p/ os estados terminais. Transições terminais->'pending' são
    // inválidas — inalcançáveis pelos callers atuais (webhook só envia paid/cancelled;
    // reconcile descarta 'pending'), mas a guarda mantém o contrato defensivo.
    async function seedOrder(
      productId: string,
      qty: number,
      pay: string,
      paymentStatus: "pending" | "paid" | "cancelled",
      stockReserved: boolean,
      stockCommitted: boolean,
    ): Promise<number> {
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
          subtotalCents: qty * 1000,
          totalCents: qty * 1000,
          paymentMethod: "PIX",
          paymentStatus,
          asaasPaymentId: pay,
          stockReserved,
          stockCommitted,
          items: {
            create: [{ productId, productName: "Test", quantity: qty, unitPriceCents: 1000 }],
          },
        },
      });
      return order.id;
    }

    it("paid -> pending é rejeitado (terminal, sem corromper flags)", async () => {
      const productId = await seedProduct(8, 0); // já baixado
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedOrder(productId, 2, pay, "paid", false, true);

      const result = await orders.setOrderPaymentStatus(orderId, "pending", {
        id: pay,
        valueCents: null,
      });

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(result.ok).toBe(false);
      expect(order.paymentStatus).toBe("paid"); // permanece
      expect(order.stockCommitted).toBe(true); // flag intacta
    });

    it("cancelled -> pending é rejeitado", async () => {
      const productId = await seedProduct(10, 0);
      const pay = `pay_${randomUUID().slice(0, 8)}`;
      const orderId = await seedOrder(productId, 2, pay, "cancelled", false, false);

      const result = await orders.setOrderPaymentStatus(orderId, "pending", {
        id: pay,
        valueCents: null,
      });

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(result.ok).toBe(false);
      expect(order.paymentStatus).toBe("cancelled"); // permanece
    });
  },
);

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// CAOS DE RUNTIME (INV-5/INV-6): reentrega CONCORRENTE do mesmo "paid". O Asaas
// reenvia o webhook ate receber 2xx; sob corrida, N entregas do mesmo pagamento
// chegam juntas. O efeito (CAS de status + baixa de estoque guardada por flags)
// tem que ser idempotente: estoque baixado EXATAMENTE uma vez, status final paid.
// Exercita setOrderPaymentStatus REAL contra Postgres. Opt-in via TEST_DATABASE_URL
// (use `pnpm test:db`).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  "concorrência — reentrega de 'paid' idempotente (INV-5)",
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

    async function seedPendingReserved(
      qty: number,
    ): Promise<{ orderId: number; productId: string }> {
      const productId = randomUUID();
      const tag = productId.slice(0, 8);
      await prisma.product.create({
        data: {
          id: productId,
          slug: `p-${tag}`,
          name: `T ${tag}`,
          category: "Tin",
          sku: `SKU-${tag}`,
          priceCents: 1000,
          imageUrl: "/x.svg",
          description: "t",
          stock: 10,
          reserved: qty, // reserva ja feita no checkout
        },
      });
      const pay = `pay_${tag}`;
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
          paymentStatus: "pending",
          asaasPaymentId: pay,
          stockReserved: true,
          stockCommitted: false,
          items: {
            create: [{ productId, productName: "T", quantity: qty, unitPriceCents: 1000 }],
          },
        },
      });
      return { orderId: order.id, productId };
    }

    it("N entregas concorrentes do mesmo 'paid': estoque baixa 1x, status paid", async () => {
      for (let i = 0; i < 30; i += 1) {
        const qty = 2;
        const { orderId, productId } = await seedPendingReserved(qty);
        const ref = { id: `pay_${productId.slice(0, 8)}`, valueCents: qty * 1000 };

        const results = await Promise.all(
          Array.from({ length: 5 }, () => orders.setOrderPaymentStatus(orderId, "paid", ref)),
        );

        const changed = results.filter((r: any) => r.ok && r.changed).length;
        const product = await prisma.product.findUnique({ where: { id: productId } });
        const order = await prisma.order.findUnique({ where: { id: orderId } });

        expect(changed).toBe(1); // exatamente uma entrega efetiva (as outras: no-op idempotente)
        expect(order.paymentStatus).toBe("paid");
        expect(order.stockCommitted).toBe(true);
        expect(product.stock).toBe(8); // 10 - 2, baixado UMA vez (nunca 6)
        expect(product.reserved).toBe(0); // reserva consumida 1x
      }
    });
  },
);

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// CAOS DE RUNTIME (INV-6/INV-8/INV-12): o PIX expira NO MEIO da reconciliacao.
// O cron expire_overdue_orders() (funcao plpgsql REAL, com janela de graca de
// 60min) cancela+estorna um pending vencido, enquanto a reconciliacao confirma o
// MESMO pedido como 'paid'. O row-lock serializa; o resultado final tem que ser
// CONSISTENTE e NUNCA "pago sem baixa de estoque", e NUNCA ressuscitar cancelled->paid:
//   - se 'paid' vence: status=paid, estoque baixado 1x, reserved=0.
//   - se expire vence: status=cancelled, reserva estornada, estoque intacto; o
//     'paid' tardio bate na guarda de transicao (cancelled->paid invalida) e nao baixa.
// Exercita a funcao do cron + setOrderPaymentStatus REAIS. Opt-in via TEST_DATABASE_URL.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const EXPIRE_MIGRATION = path.resolve(
  process.cwd(),
  "prisma/migrations/20260615070000_expire_overdue_grace/migration.sql",
);

describe.skipIf(!TEST_DATABASE_URL)(
  "concorrência — expire (cron) x reconcile (paid) [INV-12]",
  () => {
    let prisma: any;
    let orders: any;

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      prisma = (await import("../../lib/db")).prisma;
      orders = await import("../../lib/data/orders");
      // Instala expire_overdue_orders() (plpgsql puro, sem pg_cron) no banco de teste.
      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      await client.query(readFileSync(EXPIRE_MIGRATION, "utf8"));
      await client.end();
    });

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
    });

    async function seedOverduePending(
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
          reserved: qty,
        },
      });
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
          asaasPaymentId: `pay_${tag}`,
          stockReserved: true,
          stockCommitted: false,
          dueDate: new Date(Date.now() - 120 * 60_000), // vencido ha 2h (alem da graca)
          items: {
            create: [{ productId, productName: "T", quantity: qty, unitPriceCents: 1000 }],
          },
        },
      });
      return { orderId: order.id, productId };
    }

    it("nunca 'pago sem baixa', nunca ressuscita cancelled->paid", async () => {
      for (let i = 0; i < 40; i += 1) {
        const qty = 2;
        const { orderId, productId } = await seedOverduePending(qty);
        const ref = { id: `pay_${productId.slice(0, 8)}`, valueCents: qty * 1000 };

        await Promise.all([
          prisma.$executeRawUnsafe("SELECT expire_overdue_orders()"),
          orders.setOrderPaymentStatus(orderId, "paid", ref),
        ]);

        const product = await prisma.product.findUnique({ where: { id: productId } });
        const order = await prisma.order.findUnique({ where: { id: orderId } });

        expect(product.reserved).toBe(0); // reserva sempre resolvida (baixada OU estornada)
        if (order.paymentStatus === "paid") {
          expect(order.stockCommitted).toBe(true);
          expect(product.stock).toBe(8); // baixou 1x — NUNCA pago sem baixa
        } else {
          expect(order.paymentStatus).toBe("cancelled");
          expect(order.stockCommitted).toBe(false);
          expect(product.stock).toBe(10); // estorno, estoque intacto — sem ressurreicao
        }
      }
    });
  },
);

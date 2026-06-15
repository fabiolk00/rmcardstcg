import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do grace window de expire_overdue_orders() (achado CRITICO do billing).
// Opt-in via TEST_DATABASE_URL. Aplica a funcao da migration (plpgsql puro, nao
// precisa de pg_cron) no banco de teste e exercita os dois lados da janela.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATION = path.resolve(
  process.cwd(),
  "prisma/migrations/20260615070000_expire_overdue_grace/migration.sql",
);
const MIN = 60_000;

describe.skipIf(!TEST_DATABASE_URL)("expire-overdue grace window (pgcron)", () => {
  let prisma: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = (await import("../../lib/db")).prisma;
    // Aplica a funcao da migration no banco de teste (multi-statement via pg.Client).
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(readFileSync(MIGRATION, "utf8"));
    await client.end();
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function seedOverdueReserved(
    dueMsAgo: number,
  ): Promise<{ orderId: number; productId: string }> {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await prisma.product.create({
      data: {
        id,
        slug: `p-${tag}`,
        name: `T ${tag}`,
        category: "Tin",
        sku: `SKU-${tag}`,
        priceCents: 1000,
        imageUrl: "/x.svg",
        description: "t",
        stock: 10,
        reserved: 2,
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
        subtotalCents: 2000,
        totalCents: 2000,
        paymentMethod: "PIX",
        paymentStatus: "pending",
        stockReserved: true,
        stockCommitted: false,
        asaasPaymentId: `pay_${tag}`,
        dueDate: new Date(Date.now() - dueMsAgo),
        items: {
          create: [{ productId: id, productName: "T", quantity: 2, unitPriceCents: 1000 }],
        },
      },
    });
    return { orderId: order.id, productId: id };
  }

  // Vencido ha 10 min: DENTRO da graca (pode ter sido pago; o reconcile vem antes).
  it("NÃO cancela pedido vencido dentro da janela de graça", async () => {
    const { orderId, productId } = await seedOverdueReserved(10 * MIN);
    await prisma.$executeRawUnsafe("SELECT expire_overdue_orders()");
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(order.paymentStatus).toBe("pending"); // intocado dentro da graca
    expect(order.stockReserved).toBe(true);
    expect(product.reserved).toBe(2); // reserva preservada
  });

  // Vencido ha 2h: ALEM da graca -> cancela e estorna.
  it("cancela e estorna pedido vencido além da janela de graça", async () => {
    const { orderId, productId } = await seedOverdueReserved(120 * MIN);
    await prisma.$executeRawUnsafe("SELECT expire_overdue_orders()");
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    const product = await prisma.product.findUnique({ where: { id: productId } });
    expect(order.paymentStatus).toBe("cancelled");
    expect(order.stockReserved).toBe(false);
    expect(product.reserved).toBe(0); // estornado
  });
});

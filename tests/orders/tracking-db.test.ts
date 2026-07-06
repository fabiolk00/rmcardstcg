import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova de runtime (Postgres efemero) do rastreio do pedido:
//   - updateOrderTracking grava codigo + transportador e audita (order.tracking_update);
//   - idempotencia: mesmo par = no-op (changed:false, sem audit duplicado);
//   - carrier desconhecido e normalizado para null (so ids conhecidos passam);
//   - limpar (codigo vazio) volta para null.
// Opt-in via TEST_DATABASE_URL (Postgres descartavel). Sem ela, a suite e PULADA.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const actor = { clerkUserId: "admin-test", email: "admin@test.com", role: "admin" };

describe.skipIf(!TEST_DATABASE_URL)("rastreio do pedido (updateOrderTracking)", () => {
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

  async function seedOrder(): Promise<number> {
    const pid = randomUUID();
    const tag = pid.slice(0, 8);
    await prisma.product.create({
      data: {
        id: pid,
        slug: `p-${tag}`,
        name: `P ${tag}`,
        category: "Tin",
        sku: `SKU-${tag}`,
        priceCents: 1000,
        imageUrl: "/x.svg",
        description: "t",
        stock: 5,
      },
    });
    const order = await prisma.order.create({
      data: {
        userId: `u-${tag}`,
        customerName: "Cliente Teste",
        customerEmail: "c@test.com",
        customerPhone: "(41) 90000-0000",
        addressCep: "80000-000",
        addressStreet: "Rua X, 1",
        addressCity: "Curitiba",
        addressState: "PR",
        subtotalCents: 1000,
        totalCents: 1000,
        paymentMethod: "PIX",
        items: {
          create: [{ productId: pid, productName: `P ${tag}`, quantity: 1, unitPriceCents: 1000 }],
        },
      },
    });
    return order.id as number;
  }

  const auditCount = (orderId: number) =>
    prisma.auditLog.count({
      where: { entityType: "order", entityId: String(orderId), action: "order_tracking_update" },
    });
  const read = (orderId: number) => prisma.order.findUnique({ where: { id: orderId } });

  it("grava codigo + transportador e audita; idempotente no segundo igual", async () => {
    const id = await seedOrder();

    const r1 = await orders.updateOrderTracking(
      id,
      { trackingCode: "AA123456789BR", carrier: "correios" },
      actor,
    );
    expect(r1.ok && r1.changed).toBe(true);
    let row = await read(id);
    expect(row.trackingCode).toBe("AA123456789BR");
    expect(row.shippingCarrier).toBe("correios");
    expect(await auditCount(id)).toBe(1);

    // Mesmo par -> no-op (sem audit novo).
    const r2 = await orders.updateOrderTracking(
      id,
      { trackingCode: "AA123456789BR", carrier: "correios" },
      actor,
    );
    expect(r2.ok && r2.changed).toBe(false);
    expect(await auditCount(id)).toBe(1);

    // Transportador desconhecido -> normalizado para null (codigo permanece).
    const r3 = await orders.updateOrderTracking(
      id,
      { trackingCode: "AA123456789BR", carrier: "fedex" },
      actor,
    );
    expect(r3.ok && r3.changed).toBe(true);
    row = await read(id);
    expect(row.shippingCarrier).toBeNull();

    // Limpar codigo -> null.
    const r4 = await orders.updateOrderTracking(id, { trackingCode: "", carrier: null }, actor);
    expect(r4.ok && r4.changed).toBe(true);
    row = await read(id);
    expect(row.trackingCode).toBeNull();
  });
});

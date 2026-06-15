import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova da exclusao de cupom (deleteCoupon — o "D" do CRUD).
//  - cupom SEM redencao: excluido e gera audit_log coupon.delete.
//  - cupom COM redencao: BLOQUEADO (integridade financeira; FK onDelete Restrict),
//    o registro continua existindo.
// Opt-in via TEST_DATABASE_URL (igual as demais suites de DB).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ACTOR = { clerkUserId: null, email: null, role: null };

describe.skipIf(!TEST_DATABASE_URL)("deleteCoupon", () => {
  let prisma: any;
  let coupons: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = (await import("../../lib/db")).prisma;
    coupons = await import("../../lib/data/coupons");
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function seedOrder(userId: string): Promise<number> {
    const order = await prisma.order.create({
      data: {
        userId,
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
      },
    });
    return order.id;
  }

  it("exclui cupom sem redenções e grava audit_log coupon.delete", async () => {
    const coupon = await prisma.coupon.create({
      data: { code: `DEL${randomUUID().slice(0, 8)}`, type: "percent", percentOff: 10 },
    });

    const result = await coupons.deleteCoupon(ACTOR, coupon.id);
    expect(result.ok).toBe(true);

    const stillThere = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    expect(stillThere).toBeNull(); // removido de fato

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "coupon", entityId: coupon.id, action: "coupon_delete" },
    });
    expect(audit).not.toBeNull(); // exclusao auditada
  });

  it("bloqueia exclusão de cupom já redimido (preserva histórico)", async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const coupon = await prisma.coupon.create({
      data: { code: `USED${randomUUID().slice(0, 8)}`, type: "percent", percentOff: 10 },
    });
    const orderId = await seedOrder(userId);
    await prisma.couponRedemption.create({
      data: { couponId: coupon.id, orderId, userId, discountCents: 100 },
    });

    const result = await coupons.deleteCoupon(ACTOR, coupon.id);
    expect(result.ok).toBe(false);

    const stillThere = await prisma.coupon.findUnique({ where: { id: coupon.id } });
    expect(stillThere).not.toBeNull(); // cupom usado permanece
  });
});

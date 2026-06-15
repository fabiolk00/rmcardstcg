import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do per_user_limit determinístico (achado users 🟠). redeemCoupon agora
// serializa redenções do mesmo (cupom,usuário) com um advisory lock transacional,
// então o limite vale mesmo sob READ COMMITTED (sem depender do SSI/Serializable).
// Opt-in via TEST_DATABASE_URL.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("per_user_limit sob concorrência (redeemCoupon)", () => {
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

  it("dois checkouts concorrentes do mesmo usuário redimem o cupom UMA vez", async () => {
    for (let i = 0; i < 30; i += 1) {
      const userId = `u-${randomUUID().slice(0, 8)}`;
      const coupon = await prisma.coupon.create({
        data: { code: `C${randomUUID().slice(0, 8)}`, type: "percent", percentOff: 10 },
      });
      const [orderA, orderB] = [await seedOrder(userId), await seedOrder(userId)];
      const args = (orderId: number) => ({
        couponId: coupon.id,
        orderId,
        userId,
        discountCents: 100,
        perUserLimit: 1,
        maxRedemptions: null,
      });

      const results = await Promise.all([
        prisma.$transaction((tx: any) => coupons.redeemCoupon(tx, args(orderA))),
        prisma.$transaction((tx: any) => coupons.redeemCoupon(tx, args(orderB))),
      ]);

      const newRedemptions = results.filter((r: any) => r.ok && !r.alreadyRedeemed).length;
      const count = await prisma.couponRedemption.count({
        where: { couponId: coupon.id, userId },
      });
      expect(count).toBe(1); // nunca 2 (limite respeitado deterministicamente)
      expect(newRedemptions).toBe(1);
    }
  });
});

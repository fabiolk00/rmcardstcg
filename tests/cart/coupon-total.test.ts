import { describe, expect, it } from "vitest";

import { couponDiscountCents } from "../../lib/cart/coupon";
import { cartTotals, type CartLine } from "../../lib/cart/totals";

// Invariante "total exibido == total cobrado": previewCoupon (UI) e o checkout usam
// EXATAMENTE esta fórmula — finalTotal = max(frete, total - descontoCupom), com o
// frete decidido sobre a mercadoria ANTES do cupom. Este teste a trava (puro, sem DB).

function line(priceCents: number, discountPct: number, quantity: number): CartLine {
  return {
    product: { id: "x", slug: "x", name: "x", imageUrl: "", priceCents, discountPct, stock: 100 },
    quantity,
  };
}

function finalTotal(
  lines: CartLine[],
  coupon: { type: "percent" | "fixed"; percentOff: number | null; valueCents: number | null },
) {
  const totals = cartTotals(lines);
  const discount = couponDiscountCents(coupon as never, totals.merchandiseCents);
  return {
    shipping: totals.shippingCents,
    discount,
    final: Math.max(totals.shippingCents, totals.totalCents - discount),
  };
}

describe("total com cupom (preview == checkout)", () => {
  it("percentual sobre mercadoria; abaixo de R$299 cobra frete flat", () => {
    const r = finalTotal([line(10000, 0, 1)], {
      type: "percent",
      percentOff: 10,
      valueCents: null,
    });
    expect(r.shipping).toBe(2500); // < R$299 -> frete flat
    expect(r.discount).toBe(1000); // 10% de 10000
    expect(r.final).toBe(11500); // 12500 - 1000
  });

  it("cupom NÃO derruba o frete grátis já conquistado (>= R$299)", () => {
    const r = finalTotal([line(30000, 0, 1)], {
      type: "fixed",
      percentOff: null,
      valueCents: 5000,
    });
    expect(r.shipping).toBe(0); // mercadoria >= R$299 -> grátis (decidido antes do cupom)
    expect(r.final).toBe(25000); // 30000 - 5000, frete continua 0
  });

  it("desconto de cupom nunca passa do valor da mercadoria", () => {
    const r = finalTotal([line(4000, 0, 1)], {
      type: "fixed",
      percentOff: null,
      valueCents: 999999,
    });
    expect(r.discount).toBe(4000); // limitado à mercadoria
    expect(r.final).toBe(2500); // frete flat permanece (total 6500 - 4000)
  });
});

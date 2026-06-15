import type { Coupon } from "@/lib/data/coupons";

/**
 * Calculo do abatimento de cupom — funcao PURA, server-side (fonte de verdade).
 *
 * Aplica sobre merchandiseCents (subtotal ja descontado o desconto de produto,
 * ver lib/cart/totals.ts):
 * - 'percent': Math.round(merchandise * percentOff / 100).
 * - 'fixed':   valueCents.
 * O resultado e limitado a [0, merchandiseCents] — nunca negativa o total e nunca
 * abate mais do que o valor das mercadorias.
 */
export function couponDiscountCents(coupon: Coupon, merchandiseCents: number): number {
  if (merchandiseCents <= 0) return 0;

  let raw = 0;
  if (coupon.type === "percent" && coupon.percentOff !== null) {
    raw = Math.round((merchandiseCents * coupon.percentOff) / 100);
  } else if (coupon.type === "fixed" && coupon.valueCents !== null) {
    raw = coupon.valueCents;
  }

  return Math.max(0, Math.min(raw, merchandiseCents));
}

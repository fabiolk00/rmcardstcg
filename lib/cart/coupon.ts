import type { Coupon, CouponRejection } from "@/lib/data/coupons";

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

/**
 * Mensagem amigavel por motivo de rejeicao do cupom. Os motivos que revelam a
 * EXISTENCIA/estado do codigo (not_found, inactive, not_started, expired,
 * max_redemptions) colapsam numa unica mensagem generica, para a resposta nao
 * virar um oraculo de enumeracao de cupons validos (mitiga, mas nao substitui,
 * rate limiting). below_min e per_user_limit ficam especificos: sao acionaveis e
 * so ocorrem para quem ja tem um codigo valido em maos.
 */
export function couponErrorMessage(reason: CouponRejection): string {
  switch (reason) {
    case "below_min":
      return "Seu pedido não atinge o valor mínimo para este cupom.";
    case "per_user_limit":
      return "Você já utilizou este cupom o número máximo de vezes.";
    default:
      return "Cupom inválido ou indisponível.";
  }
}

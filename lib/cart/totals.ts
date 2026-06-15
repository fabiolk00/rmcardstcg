import type { Product } from "@/lib/data/types";
import { finalPriceCents } from "@/lib/data/pricing";

// Frete gratis acima de R$ 299 (sobre o valor das mercadorias ja com desconto).
export const FREE_SHIPPING_THRESHOLD_CENTS = 29900;
// Frete flat abaixo do limite (assuncao de mock; o handoff nao especifica o valor).
export const FLAT_SHIPPING_CENTS = 2500;

// Snapshot minimo do produto guardado no carrinho (como a API real faria).
export type CartProduct = Pick<
  Product,
  "id" | "slug" | "name" | "imageUrl" | "priceCents" | "discountPct" | "stock"
>;

export type CartLine = { product: CartProduct; quantity: number };

export type CartTotals = {
  subtotalCents: number;
  discountCents: number;
  merchandiseCents: number;
  shippingCents: number;
  totalCents: number;
  remainingForFreeCents: number;
};

export function cartTotals(lines: CartLine[]): CartTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + l.product.priceCents * l.quantity, 0);
  const discountCents = lines.reduce(
    (sum, l) => sum + (l.product.priceCents - finalPriceCents(l.product)) * l.quantity,
    0,
  );
  const merchandiseCents = subtotalCents - discountCents;
  const freeShipping = merchandiseCents === 0 || merchandiseCents >= FREE_SHIPPING_THRESHOLD_CENTS;
  const shippingCents = freeShipping ? 0 : FLAT_SHIPPING_CENTS;
  const totalCents = merchandiseCents + shippingCents;
  const remainingForFreeCents = Math.max(0, FREE_SHIPPING_THRESHOLD_CENTS - merchandiseCents);
  return {
    subtotalCents,
    discountCents,
    merchandiseCents,
    shippingCents,
    totalCents,
    remainingForFreeCents,
  };
}

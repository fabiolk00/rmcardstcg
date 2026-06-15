import type { Product } from "./types";

/**
 * Preco final em centavos (derivado): base x (1 - desconto/100). Nunca salvo.
 *
 * Funcao pura, isolada do modulo de dados (products.ts) para que componentes
 * client possam usa-la sem arrastar o array de mock para o bundle do navegador.
 */
export function finalPriceCents(p: Pick<Product, "priceCents" | "discountPct">): number {
  return Math.round(p.priceCents * (1 - p.discountPct / 100));
}

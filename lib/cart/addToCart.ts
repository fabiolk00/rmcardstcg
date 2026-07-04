import type { CartLine, CartProduct } from "./totals";

/**
 * Logica PURA de "adicionar ao carrinho" com CHECK de estoque — fonte unica
 * usada pelo CartContext (a decisao e o reducer saem daqui; o contexto so
 * orquestra estado/persistencia). Pura para ser testavel sem React.
 *
 * Regra: limite = available (estoque - reservado no momento do snapshot) com
 * fallback stock. ok=false quando esgotado (limite <= 0) OU o carrinho ja tem
 * todo o disponivel — nesse caso `lines` volta INALTERADO (nada e adicionado;
 * a UI mostra "produto indisponivel"). Quantidade pedida acima do restante e
 * clampada ao limite (adiciona o que da).
 */
export type AddToCartResult = {
  ok: boolean;
  lines: CartLine[];
};

const stockLimit = (product: CartProduct): number => product.available ?? product.stock;

const clampToStock = (quantity: number, limit: number) => Math.max(1, Math.min(quantity, limit));

/** true se AINDA cabe pelo menos 1 unidade do produto no carrinho. */
export function canAddToCart(lines: CartLine[], product: CartProduct): boolean {
  const limit = stockLimit(product);
  const current = lines.find((l) => l.product.id === product.id)?.quantity ?? 0;
  return limit > 0 && current < limit;
}

/** Reducer puro do add: decide + devolve as novas linhas (ou as mesmas, se recusado). */
export function addToCartLines(
  lines: CartLine[],
  product: CartProduct,
  quantity = 1,
): AddToCartResult {
  if (!canAddToCart(lines, product)) return { ok: false, lines };

  const limit = stockLimit(product);
  const existing = lines.find((l) => l.product.id === product.id);
  if (existing) {
    return {
      ok: true,
      lines: lines.map((l) =>
        l.product.id === product.id
          ? { ...l, quantity: clampToStock(l.quantity + quantity, limit) }
          : l,
      ),
    };
  }
  return { ok: true, lines: [...lines, { product, quantity: clampToStock(quantity, limit) }] };
}

import { describe, expect, it } from "vitest";

import { addToCartLines, canAddToCart } from "@/lib/cart/addToCart";
import type { CartLine, CartProduct } from "@/lib/cart/totals";

// Logica PURA do "Compre agora" com CHECK de estoque (lib/cart/addToCart) —
// fonte unica usada pelo CartContext. Regra: ok=false quando esgotado ou o
// carrinho ja tem todo o disponivel (lines volta INALTERADO); pedido acima do
// restante e clampado. Cobre o footgun historico do clampToStock
// (Math.max(1,...) adicionava 1 unidade com estoque ZERO em pagina velha).

function product(overrides: Partial<CartProduct> = {}): CartProduct {
  return {
    id: "p-1",
    slug: "carta-teste",
    name: "Carta Teste",
    imageUrl: "/img.png",
    priceCents: 1000,
    discountPct: 0,
    stock: 5,
    available: 5,
    ...overrides,
  };
}

const lineOf = (p: CartProduct, quantity: number): CartLine => ({ product: p, quantity });

describe("canAddToCart", () => {
  it("carrinho vazio + estoque disponivel => true", () => {
    expect(canAddToCart([], product())).toBe(true);
  });

  it("ESGOTADO (available 0) => false — nada de adicionar 1 por engano", () => {
    expect(canAddToCart([], product({ available: 0, stock: 0 }))).toBe(false);
  });

  it("available 0 mas stock > 0 (tudo reservado) => false — available manda", () => {
    expect(canAddToCart([], product({ available: 0, stock: 5 }))).toBe(false);
  });

  it("carrinho JA no limite do disponivel => false", () => {
    const p = product({ available: 2 });
    expect(canAddToCart([lineOf(p, 2)], p)).toBe(false);
  });

  it("carrinho abaixo do limite => true", () => {
    const p = product({ available: 2 });
    expect(canAddToCart([lineOf(p, 1)], p)).toBe(true);
  });

  it("snapshot antigo SEM available cai no stock (fallback documentado)", () => {
    const p = product({ available: undefined, stock: 1 });
    expect(canAddToCart([], p)).toBe(true);
    expect(canAddToCart([lineOf(p, 1)], p)).toBe(false);
  });
});

describe("addToCartLines", () => {
  it("recusa (esgotado): ok=false e lines volta INALTERADO (mesma referencia)", () => {
    const lines: CartLine[] = [];
    const res = addToCartLines(lines, product({ available: 0, stock: 0 }));
    expect(res.ok).toBe(false);
    expect(res.lines).toBe(lines); // nada criado, nem copia
  });

  it("recusa (limite no carrinho): ok=false e quantidade nao muda", () => {
    const p = product({ available: 2 });
    const lines = [lineOf(p, 2)];
    const res = addToCartLines(lines, p);
    expect(res.ok).toBe(false);
    expect(res.lines[0].quantity).toBe(2);
  });

  it("produto novo: cria linha com a quantidade pedida", () => {
    const res = addToCartLines([], product(), 2);
    expect(res.ok).toBe(true);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].quantity).toBe(2);
  });

  it("produto existente: INCREMENTA a quantidade", () => {
    const p = product();
    const res = addToCartLines([lineOf(p, 1)], p, 2);
    expect(res.ok).toBe(true);
    expect(res.lines[0].quantity).toBe(3);
  });

  it("pedido acima do restante: CLAMPA no limite (adiciona o que da)", () => {
    const p = product({ available: 3 });
    const res = addToCartLines([lineOf(p, 2)], p, 5);
    expect(res.ok).toBe(true);
    expect(res.lines[0].quantity).toBe(3); // 2 + 5 clampado em 3
  });

  it("linha nova pedindo acima do estoque: clampa ja na criacao", () => {
    const res = addToCartLines([], product({ available: 2 }), 10);
    expect(res.ok).toBe(true);
    expect(res.lines[0].quantity).toBe(2);
  });

  it("quantity default = 1", () => {
    const res = addToCartLines([], product());
    expect(res.lines[0].quantity).toBe(1);
  });

  it("nao mexe nas linhas de OUTROS produtos", () => {
    const other = product({ id: "p-2", name: "Outra" });
    const res = addToCartLines([lineOf(other, 4)], product());
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]).toEqual(lineOf(other, 4));
  });
});

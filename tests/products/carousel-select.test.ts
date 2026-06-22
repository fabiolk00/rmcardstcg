import { describe, expect, it } from "vitest";

import { CAROUSEL_LIMIT, selectCarouselProducts } from "../../lib/data/carousel";
import type { Product } from "../../lib/data/types";

// selectCarouselProducts e a regra do carrossel "Em destaque" da home: mostra os
// MARCADOS (isCarousel) ativos e com estoque, cap CAROUSEL_LIMIT; FALLBACK p/ os
// ativos com estoque quando ninguem esta marcado. Funcao pura -> testavel sem DB.
// Cobre, em especial, o ramo de FALLBACK, que o seed do e2e (que marca produtos)
// nunca exercita.

let seq = 0;
function p(overrides: Partial<Product>): Product {
  seq += 1;
  return {
    id: `p-${seq}`,
    slug: `slug-${seq}`,
    name: `Produto ${seq}`,
    category: "Booster Box",
    sku: `SKU-${seq}`,
    priceCents: 1000,
    discountPct: 0,
    rating: 5,
    reviewCount: 0,
    stock: 10,
    isActive: true,
    isCarousel: false,
    badge: null,
    imageUrl: "/products/placeholder.svg",
    description: "x",
    weightGrams: 0,
    lengthCm: 0,
    widthCm: 0,
    heightCm: 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectCarouselProducts", () => {
  it("retorna apenas os marcados, ativos e com estoque", () => {
    const marked = p({ isCarousel: true, name: "Marcado" });
    const products = [
      marked,
      p({ isCarousel: false, name: "Nao marcado" }),
      p({ isCarousel: true, isActive: false, name: "Marcado inativo" }),
      p({ isCarousel: true, stock: 0, name: "Marcado sem estoque" }),
    ];
    const out = selectCarouselProducts(products);
    expect(out.map((x) => x.name)).toEqual(["Marcado"]);
  });

  it("preserva a ordem recebida e limita a CAROUSEL_LIMIT", () => {
    const many = Array.from({ length: CAROUSEL_LIMIT + 4 }, (_, i) =>
      p({ isCarousel: true, name: `M${i}` }),
    );
    const out = selectCarouselProducts(many);
    expect(out).toHaveLength(CAROUSEL_LIMIT);
    expect(out.map((x) => x.name)).toEqual(
      Array.from({ length: CAROUSEL_LIMIT }, (_, i) => `M${i}`),
    );
  });

  it("respeita um limite customizado", () => {
    const many = Array.from({ length: 5 }, () => p({ isCarousel: true }));
    expect(selectCarouselProducts(many, 3)).toHaveLength(3);
  });

  it("FALLBACK: sem nenhum marcado elegivel, cai para os ativos com estoque (cap)", () => {
    const products = [
      p({ isCarousel: false, name: "A" }),
      p({ isCarousel: false, name: "B" }),
      p({ isCarousel: false, isActive: false, name: "Inativo" }),
      p({ isCarousel: false, stock: 0, name: "Sem estoque" }),
    ];
    const out = selectCarouselProducts(products);
    // So A e B sao elegiveis (ativos, stock>0); inativo e sem-estoque ficam de fora.
    expect(out.map((x) => x.name)).toEqual(["A", "B"]);
  });

  it("FALLBACK so dispara quando NENHUM marcado e elegivel (marcado inativo nao conta)", () => {
    const products = [
      p({ isCarousel: true, isActive: false, name: "Marcado inativo" }),
      p({ isCarousel: false, name: "Ativo nao marcado" }),
    ];
    // O unico marcado e inativo (nao elegivel) -> fallback para o ativo nao marcado.
    expect(selectCarouselProducts(products).map((x) => x.name)).toEqual(["Ativo nao marcado"]);
  });

  it("lista vazia -> []", () => {
    expect(selectCarouselProducts([])).toEqual([]);
  });
});

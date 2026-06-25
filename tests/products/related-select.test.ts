import { describe, expect, it } from "vitest";

import { RELATED_LIMIT, selectRelatedProducts } from "../../lib/data/related";
import type { Product } from "../../lib/data/types";

// selectRelatedProducts e a regra de "produtos relacionados" da pagina de produto:
// mesma categoria, ativos, EXCLUI o proprio, em-estoque antes dos esgotados, cap
// RELATED_LIMIT. Funcao pura -> testavel sem DB (espelha carousel-select.test.ts).

let seq = 0;
function p(overrides: Partial<Product>): Product {
  seq += 1;
  const base: Product = {
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
    available: 10,
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
  // available espelha o stock (sem reservas) salvo override explicito do teste.
  return { ...base, available: overrides.available ?? base.stock };
}

describe("selectRelatedProducts", () => {
  it("retorna apenas a MESMA categoria, ativos, exceto o proprio produto", () => {
    const current = p({ id: "cur", category: "Tin", name: "Atual" });
    const pool = [
      current,
      p({ category: "Tin", name: "Mesmo cat A" }),
      p({ category: "Tin", name: "Mesmo cat B" }),
      p({ category: "Booster Box", name: "Outra cat" }),
      p({ category: "Tin", isActive: false, name: "Inativo mesmo cat" }),
    ];
    const out = selectRelatedProducts(pool, current);
    expect(out.map((x) => x.name)).toEqual(["Mesmo cat A", "Mesmo cat B"]);
  });

  it("prioriza os com estoque antes dos esgotados, preservando a ordem", () => {
    const current = p({ id: "cur", category: "Tin" });
    const pool = [
      current,
      p({ category: "Tin", stock: 0, name: "Esgotado 1" }),
      p({ category: "Tin", stock: 5, name: "Em estoque 1" }),
      p({ category: "Tin", stock: 0, name: "Esgotado 2" }),
      p({ category: "Tin", stock: 2, name: "Em estoque 2" }),
    ];
    const out = selectRelatedProducts(pool, current);
    expect(out.map((x) => x.name)).toEqual([
      "Em estoque 1",
      "Em estoque 2",
      "Esgotado 1",
      "Esgotado 2",
    ]);
  });

  it("limita a RELATED_LIMIT", () => {
    const current = p({ id: "cur", category: "Tin" });
    const pool = [
      current,
      ...Array.from({ length: RELATED_LIMIT + 3 }, (_, i) =>
        p({ category: "Tin", name: `R${i}` }),
      ),
    ];
    expect(selectRelatedProducts(pool, current)).toHaveLength(RELATED_LIMIT);
  });

  it("respeita um limite customizado", () => {
    const current = p({ id: "cur", category: "Tin" });
    const pool = [current, ...Array.from({ length: 5 }, () => p({ category: "Tin" }))];
    expect(selectRelatedProducts(pool, current, 2)).toHaveLength(2);
  });

  it("sem produtos da mesma categoria -> []", () => {
    const current = p({ id: "cur", category: "Tin" });
    const pool = [current, p({ category: "Booster Box" }), p({ category: "Acessórios" })];
    expect(selectRelatedProducts(pool, current)).toEqual([]);
  });
});

/**
 * Fixtures de PRODUTOS (cartas TCG) para a matriz de testes de frete.
 *
 * Peso e dimensoes sao os drivers do frete; a tabela cobre as categorias
 * representativas do dominio (single, lote, booster, box, deck, acessorios),
 * incluindo item de alto valor (seguro/valor declarado) e item barato (piso).
 * Deterministico: tabela fixa; nada aleatorio.
 *
 * Peso em GRAMAS e dimensoes em CM, como o dominio (lib/services/superfrete/
 * dimensions). Dimensao 0 = "sem medida propria" -> effectivePackage cai no
 * default da categoria (exercita o fallback real da integracao).
 */

import type { Category } from "@/lib/data/types";
import { effectivePackage, type PackageDims } from "@/lib/services/superfrete/dimensions";
import type { QuoteItem } from "@/lib/services/superfrete/quote";

export type FixtureProduct = {
  sku: string;
  name: string;
  category: Category;
  /** Preco unitario em centavos (inteiro, convencao do dominio). */
  priceCents: number;
  discountPct: number;
  weightGrams: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
};

type Row = [
  sku: string,
  name: string,
  category: Category,
  priceCents: number,
  weightGrams: number,
  /** alt x larg x comp (cm) */
  dims: [h: number, w: number, l: number],
];

const ROWS: readonly Row[] = [
  // Carta avulsa barata (piso de peso/preco). Dims 0 -> fallback da categoria
  // Single Card (50g, 13x9x2) — exercita o caminho real de fallback.
  ["SGL-BULK-001", "Carta Avulsa Comum — Rattata (bulk)", "Single Card", 500, 0, [0, 0, 0]],
  // Carta rara de alto valor (R$ 2.500) em toploader + envelope rigido.
  ["SGL-RARE-001", "Carta Rara — Charizard ex Alt Art", "Single Card", 250000, 20, [1, 11, 16]],
  // Lote de 100 cartas comuns em caixa pequena (compacto: peso real domina).
  ["LOT-100-001", "Lote 100 Cartas Comuns Sortidas", "Single Card", 4900, 220, [7, 10, 14]],
  // Pacote lacrado.
  ["BST-SV-001", "Booster Pack Escarlate & Violeta", "Booster Pack", 2790, 25, [1, 9, 13]],
  // Booster box/display (cubagem relevante).
  [
    "BBX-SV-001",
    "Booster Box Escarlate & Violeta (36 packs)",
    "Booster Box",
    79900,
    550,
    [10, 12, 16],
  ],
  // Elite Trainer Box (pesado, caixa grande).
  [
    "ETB-SV-001",
    "Elite Trainer Box Escarlate & Violeta",
    "Elite Trainer Box",
    24990,
    950,
    [11, 19, 21],
  ],
  // Deck estruturado / precon.
  ["DCK-PRE-001", "Deck Batalha de Liga (precon)", "Coleção Especial", 12990, 200, [4, 13, 19]],
  // Acessorios.
  ["ACC-SLV-001", "Sleeves Premium (100 un)", "Acessórios", 3490, 60, [3, 7, 10]],
  // Deck box magnetico: MESMO peso real do playmat (300g), volume pequeno —
  // par de controle para provar que a CUBAGEM (nao so o peso) muda o frete.
  ["ACC-DBX-001", "Deck Box Magnético", "Acessórios", 4990, 300, [8, 8, 10]],
  // Playmat enrolado: dimensao longa; cubado (40x8x8/6000 ≈ 427g) > real (300g).
  ["ACC-PLM-001", "Playmat Enrolado (tubo)", "Acessórios", 14990, 300, [8, 8, 40]],
];

export const PRODUCTS: readonly FixtureProduct[] = ROWS.map(
  ([sku, name, category, priceCents, weightGrams, [h, w, l]]) => ({
    sku,
    name,
    category,
    priceCents,
    discountPct: 0,
    weightGrams,
    heightCm: h,
    widthCm: w,
    lengthCm: l,
  }),
);

/** Busca por SKU; lanca se a fixture nao existir (erro de teste, nao de integracao). */
export function product(sku: string): FixtureProduct {
  const p = PRODUCTS.find((x) => x.sku === sku);
  if (!p) throw new Error(`fixture de produto inexistente: ${sku}`);
  return p;
}

/** Medidas EFETIVAS do pacote (medida propria com fallback por categoria). */
export function pkgOf(sku: string): PackageDims {
  return effectivePackage(product(sku));
}

/** Linha de carrinho pronta para quoteShipping: {quantity, pkg, unitPriceCents}. */
export function quoteItem(sku: string, quantity = 1): QuoteItem {
  const p = product(sku);
  // discountPct e 0 nas fixtures => valor final == priceCents (mercadoria declarada).
  return { quantity, pkg: pkgOf(sku), unitPriceCents: p.priceCents };
}

/** Mercadoria (centavos) de um carrinho de fixtures — para a regra de frete gratis. */
export function merchandiseCents(cart: { sku: string; quantity: number }[]): number {
  return cart.reduce((sum, l) => sum + product(l.sku).priceCents * l.quantity, 0);
}

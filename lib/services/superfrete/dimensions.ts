import type { Category } from "@/lib/data/types";

/**
 * Medidas de pacote para frete (com margem de embalagem), POR CATEGORIA. Usadas como:
 *  - default no admin (auto-preenche um produto novo conforme a categoria);
 *  - FALLBACK na cotacao quando o produto nao tem medida propria (campo 0).
 *
 * Fonte (lojista, "para frete" — ja com margem): Blister Triplo/Quadruplo, ETB,
 * Booster Box (usamos o de 36 boosters como conservador — o admin ajusta por produto
 * para 18 quando for o caso) e Parceiro Inicial Serie 2 (mapeado em "Colecao Especial").
 * As demais categorias (Booster Pack, Tin, Acessorios, Single Card) sao ESTIMATIVAS
 * razoaveis ate haver medida do lojista — ajuste por produto quando precisar.
 *
 * Peso em GRAMAS, dimensoes em CM (Int).
 */
export type PackageDims = {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

export const CATEGORY_PACKAGE: Record<Category, PackageDims> = {
  "Blister Triplo": { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 },
  "Blister Quadruplo": { weightGrams: 200, lengthCm: 24, widthCm: 20, heightCm: 4 },
  "Elite Trainer Box": { weightGrams: 1000, lengthCm: 21, widthCm: 19, heightCm: 11 },
  // Booster Box: default = 36 boosters (conservador). Para 18, edite o produto
  // (≈ 15x9x8, 600g).
  "Booster Box": { weightGrams: 1000, lengthCm: 15, widthCm: 9, heightCm: 14 },
  // ≈ Box Parceiro Inicial Serie 2 (a "colecao especial" mais volumosa do catalogo).
  "Coleção Especial": { weightGrams: 1000, lengthCm: 35, widthCm: 26, heightCm: 6 },
  // --- estimativas (sem dado do lojista) ---
  "Booster Pack": { weightGrams: 60, lengthCm: 13, widthCm: 9, heightCm: 2 },
  Tin: { weightGrams: 400, lengthCm: 20, widthCm: 14, heightCm: 7 },
  Acessórios: { weightGrams: 300, lengthCm: 25, widthCm: 20, heightCm: 5 },
  "Single Card": { weightGrams: 50, lengthCm: 13, widthCm: 9, heightCm: 2 },
};

type ProductDims = {
  category: Category;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

/**
 * Medidas efetivas do pacote de um produto: usa as do PROPRIO produto quando
 * definidas (> 0) e cai no default da categoria campo a campo quando 0. Assim um
 * produto sem medida ainda cota com um pacote coerente, e o admin so preenche o que
 * difere do padrao.
 */
export function effectivePackage(p: ProductDims): PackageDims {
  const def = CATEGORY_PACKAGE[p.category];
  return {
    weightGrams: p.weightGrams > 0 ? p.weightGrams : def.weightGrams,
    lengthCm: p.lengthCm > 0 ? p.lengthCm : def.lengthCm,
    widthCm: p.widthCm > 0 ? p.widthCm : def.widthCm,
    heightCm: p.heightCm > 0 ? p.heightCm : def.heightCm,
  };
}

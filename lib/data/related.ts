import type { Product } from "./types";

/**
 * Selecao de "produtos relacionados" da pagina de produto — funcao PURA (sem DB),
 * testavel por unidade (espelha o padrao de lib/data/carousel.ts).
 *
 * Regra: mesma categoria do produto atual, ativos, EXCLUI o proprio produto,
 * prioriza os com estoque (>0) antes dos esgotados (sort estavel, preserva a ordem
 * recebida dentro de cada grupo — getActiveProducts entrega por createdAt desc), no
 * maximo RELATED_LIMIT. A filtragem por categoria/ativo tambem roda na query
 * (getRelatedProducts); manter aqui deixa a regra testavel isolada do DB.
 */
export const RELATED_LIMIT = 4;

export function selectRelatedProducts(
  pool: Product[],
  current: Pick<Product, "id" | "category">,
  limit = RELATED_LIMIT,
): Product[] {
  const sameCategory = pool.filter(
    (p) => p.id !== current.id && p.isActive && p.category === current.category,
  );
  const inStock = sameCategory.filter((p) => p.stock > 0);
  const soldOut = sameCategory.filter((p) => p.stock <= 0);
  return [...inStock, ...soldOut].slice(0, limit);
}

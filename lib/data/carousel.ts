import type { Product } from "./types";

/**
 * Selecao do carrossel "Em destaque" da landing — funcao PURA (sem DB) para ser
 * testavel por unidade (cobre inclusive o ramo de fallback, que o seed do e2e — que
 * marca produtos — nunca exercita).
 *
 * Regra: exibe os produtos MARCADOS (isCarousel), ativos e com disponivel (>0), no
 * maximo CAROUSEL_LIMIT, preservando a ordem recebida (getActiveProducts ja entrega
 * por createdAt desc). FALLBACK: se NENHUM marcado for elegivel, cai para os ativos
 * com disponivel — assim a home nunca fica vazia logo apos o deploy, quando ainda
 * ninguem foi marcado (a coluna nasce com default false).
 */
export const CAROUSEL_LIMIT = 8;

export function selectCarouselProducts(products: Product[], limit = CAROUSEL_LIMIT): Product[] {
  const eligible = products.filter((p) => p.isActive && p.available > 0);
  const marked = eligible.filter((p) => p.isCarousel);
  return (marked.length > 0 ? marked : eligible).slice(0, limit);
}

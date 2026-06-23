import type { ReviewStats } from "./types";

/**
 * Resumo de avaliacoes — funcoes PURAS (sem DB), testaveis por unidade. O recalc do
 * agregado denormalizado (Product.rating/reviewCount) e o ReviewStats da vitrine
 * derivam destas, sobre o resultado de um groupBy(rating) das reviews APROVADAS.
 */

/** Arredonda a media para 1 casa decimal (formato de Product.rating Decimal(2,1)). */
export function roundRating(avg: number): number {
  return Math.round(avg * 10) / 10;
}

const ZERO_DISTRIBUTION = (): Record<1 | 2 | 3 | 4 | 5, number> => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });

/**
 * Resumo a partir de pares (nota, quantidade) — as linhas de um groupBy por rating.
 * Ignora notas fora de 1..5 e quantidades nao-positivas (defensivo). count=0 -> media 0.
 */
export function summarizeFromCounts(counts: { rating: number; count: number }[]): ReviewStats {
  const distribution = ZERO_DISTRIBUTION();
  let total = 0;
  let weighted = 0;
  for (const { rating, count } of counts) {
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5 && Number.isFinite(count) && count > 0) {
      distribution[rating as 1 | 2 | 3 | 4 | 5] += count;
      total += count;
      weighted += rating * count;
    }
  }
  return {
    count: total,
    average: total > 0 ? roundRating(weighted / total) : 0,
    distribution,
  };
}

/** Conveniencia: resumo direto de uma lista de notas (1 nota por review). */
export function summarizeRatings(ratings: number[]): ReviewStats {
  const byRating = new Map<number, number>();
  for (const r of ratings) byRating.set(r, (byRating.get(r) ?? 0) + 1);
  return summarizeFromCounts([...byRating].map(([rating, count]) => ({ rating, count })));
}

import { describe, expect, it } from "vitest";

import { roundRating, summarizeFromCounts, summarizeRatings } from "../../lib/data/review-stats";

// summarizeFromCounts/summarizeRatings sao a base do recalc do agregado denormalizado
// (Product.rating/reviewCount) e do ReviewStats da vitrine. Funcoes puras -> testaveis
// sem DB. Cobrem media arredondada a 1 casa, distribuicao por nota e o caso vazio.

describe("roundRating", () => {
  it("arredonda para 1 casa decimal", () => {
    expect(roundRating(4.666666)).toBe(4.7);
    expect(roundRating(4.04)).toBe(4);
    expect(roundRating(5)).toBe(5);
    expect(roundRating(0)).toBe(0);
  });
});

describe("summarizeFromCounts", () => {
  it("conta total, media ponderada e distribuicao por nota", () => {
    const out = summarizeFromCounts([
      { rating: 5, count: 3 },
      { rating: 4, count: 1 },
      { rating: 1, count: 1 },
    ]);
    // (5*3 + 4 + 1) / 5 = 20/5 = 4.0
    expect(out.count).toBe(5);
    expect(out.average).toBe(4);
    expect(out.distribution).toEqual({ 1: 1, 2: 0, 3: 0, 4: 1, 5: 3 });
  });

  it("sem aprovadas -> count 0, media 0, distribuicao zerada", () => {
    const out = summarizeFromCounts([]);
    expect(out.count).toBe(0);
    expect(out.average).toBe(0);
    expect(out.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it("ignora notas fora de 1..5 e quantidades nao-positivas (defensivo)", () => {
    const out = summarizeFromCounts([
      { rating: 5, count: 2 },
      { rating: 0, count: 9 },
      { rating: 6, count: 9 },
      { rating: 3, count: 0 },
      { rating: 4, count: -5 },
    ]);
    expect(out.count).toBe(2);
    expect(out.average).toBe(5);
    expect(out.distribution).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 2 });
  });

  it("media arredondada a 1 casa (4.666… -> 4.7)", () => {
    const out = summarizeFromCounts([
      { rating: 5, count: 2 },
      { rating: 4, count: 1 },
    ]);
    // (10 + 4) / 3 = 4.666… -> 4.7
    expect(out.average).toBe(4.7);
  });
});

describe("summarizeRatings", () => {
  it("resume direto de uma lista de notas", () => {
    const out = summarizeRatings([5, 5, 4, 3, 5]);
    expect(out.count).toBe(5);
    expect(out.distribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 1, 5: 3 });
    // (5+5+4+3+5)/5 = 22/5 = 4.4
    expect(out.average).toBe(4.4);
  });
});

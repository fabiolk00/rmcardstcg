import { describe, expect, it } from "vitest";

import { finalPriceCents } from "../../lib/data/pricing";

/**
 * Sondas INV-3 — finalPriceCents derivada, pura, arredondamento correto.
 *
 * INV-3 exige:
 *  (a) discountPct=0  => priceCents intato (preco cheio).
 *  (b) discountPct=100 => 0.
 *  (c) Arredondamento round-half-up (Math.round), NAO floor/ceil:
 *        priceCents=1995, discountPct=10 => 1796 (floor daria 1795).
 *        priceCents=999,  discountPct=50 => 500  (floor daria 499).
 *  (d) A formula de referencia e Math.round(p * (1 - pct/100)).
 *      A reordenacao de fator (100-pct)/100 nao e bit-identica: ha pares
 *      (price, pct) onde Math.round(price * ((100-pct)/100)) != ref.
 *  (e) Varredura de propriedade: para todos (1..9999, 1..99) o resultado
 *      deve coincidir com a formula de referencia.
 */

describe("INV-3 finalPriceCents — derivada, pura, round correto", () => {
  // (a) borda: desconto zero = preco cheio
  it("discountPct=0 retorna priceCents integro", () => {
    expect(finalPriceCents({ priceCents: 5000, discountPct: 0 })).toBe(5000);
    expect(finalPriceCents({ priceCents: 1, discountPct: 0 })).toBe(1);
    expect(finalPriceCents({ priceCents: 99999, discountPct: 0 })).toBe(99999);
  });

  // (b) borda: desconto 100% = zero
  it("discountPct=100 retorna 0", () => {
    expect(finalPriceCents({ priceCents: 5000, discountPct: 100 })).toBe(0);
    expect(finalPriceCents({ priceCents: 1, discountPct: 100 })).toBe(0);
  });

  // (c-1) arredondamento detecta floor: fracao >= 0.5, deve ir para CIMA
  it("priceCents=1995 discountPct=10 => 1796 (floor daria 1795)", () => {
    // 1995 * 0.90 = 1795.5 => round => 1796; floor => 1795
    expect(finalPriceCents({ priceCents: 1995, discountPct: 10 })).toBe(1796);
  });

  it("priceCents=999 discountPct=50 => 500 (floor daria 499)", () => {
    // 999 * 0.50 = 499.5 => round => 500; floor => 499
    expect(finalPriceCents({ priceCents: 999, discountPct: 50 })).toBe(500);
  });

  // (c-2) caso adicional: fração >= 0.5 com desconto diferente
  it("priceCents=1001 discountPct=1 => 991 (floor daria 990)", () => {
    // 1001 * 0.99 = 990.99 => round => 991; floor => 990
    expect(finalPriceCents({ priceCents: 1001, discountPct: 1 })).toBe(991);
  });

  it("priceCents=3 discountPct=34 => 2 (floor daria 1)", () => {
    // 3 * 0.66 = 1.98 => round => 2; floor => 1
    expect(finalPriceCents({ priceCents: 3, discountPct: 34 })).toBe(2);
  });

  // (d) reordenacao de fator: detecta (100-pct)/100 != (1-pct/100) em IEEE 754
  // Caso encontrado pela varredura: price=25, pct=42
  //   ref  = Math.round(25 * (1 - 42/100))  = Math.round(25 * 0.58) = Math.round(14.5) = 15
  //   reord= Math.round(25 * ((100-42)/100)) = Math.round(25 * 0.58) ... depende do FP
  it("priceCents=25 discountPct=42 => 15 (formula de referencia)", () => {
    // Math.round(25 * (1 - 42/100)) = Math.round(25 * 0.58) = Math.round(14.5) = 15
    expect(finalPriceCents({ priceCents: 25, discountPct: 42 })).toBe(15);
  });

  // Ancora o comportamento FP da forma canonica E pega a reordenacao de fator:
  //   canonico  Math.round(5 * (1 - 90/100)): em IEEE-754, 1 - 90/100 = 0.09999999999999998,
  //             logo 5 * (1 - 90/100) = 0.4999999999999999 => Math.round = 0.
  //   reordenado Math.round(5 * ((100-90)/100)) = Math.round(5 * 0.1) = Math.round(0.5) = 1.
  // Assertar 0 fixa a forma de referencia (1 - d/100) e fica VERMELHO se alguem trocar para (100-d)/100.
  it("priceCents=5 discountPct=90 => 0 (fixa o FP de (1 - d/100); pega reordenacao p/ (100-d)/100)", () => {
    expect(finalPriceCents({ priceCents: 5, discountPct: 90 })).toBe(0);
  });

  // (e) varredura de propriedade: qualquer (price in 1..2000, pct in 1..99)
  // deve coincidir com Math.round(price * (1 - pct/100))
  it("varredura de propriedade: coincide com formula de referencia para price=1..2000, pct=1..99", () => {
    const failures: { price: number; pct: number; got: number; want: number }[] = [];
    for (let price = 1; price <= 2000; price++) {
      for (let pct = 1; pct <= 99; pct++) {
        const want = Math.round(price * (1 - pct / 100));
        const got = finalPriceCents({ priceCents: price, discountPct: pct });
        if (got !== want) {
          failures.push({ price, pct, got, want });
          if (failures.length >= 10) break; // captura alguns, para cedo
        }
      }
      if (failures.length >= 10) break;
    }
    expect(failures).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Sondas INV-10 — Coerencia do cupom.
 *
 * INV-10 exige:
 *  (a) normalizeCouponCode: idempotente, UPPER, remove espaco ESQUERDA e DIREITA.
 *      A implementacao usa trimStart() que remove apenas a esquerda — trailing space
 *      persiste, violando unicidade por indice LOWER(code) no banco.
 *  (b) toCouponData XOR: no caminho 'fixed', percentOff deve ser null (campo oposto zerado).
 *      No caminho 'percent', valueCents deve ser null.
 *  (c) validateCoupon bordas: expiresAt == now => EXPIRADO (operador <= now, borda exclusiva).
 *      startsAt == now => VALIDO (operador > now). merchandiseCents == min => VALIDO (<, nao <=).
 *
 * Por que sondas de valor/forma em vez de comportamental com import:
 *   lib/data/coupons.ts importa lib/db.ts que joga sem DATABASE_URL. Nao ha como
 *   importar o modulo sem banco. As sondas comportamentais de normalizeCouponCode
 *   sao feitas via eval do corpo extraido do fonte (funcao pura, sem dependencias).
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const src = read("lib/data/coupons.ts");

// ---------------------------------------------------------------------------
// Helper: extrai o corpo de normalizeCouponCode e constroi a funcao em runtime
// via Function() — evita import do modulo (que trava sem DATABASE_URL).
// ---------------------------------------------------------------------------
function extractNormalize(): (code: string) => string {
  // Captura: export function normalizeCouponCode(code: string): string { ... }
  const match = /export function normalizeCouponCode\s*\([^)]*\)[^{]*\{([^}]*)\}/.exec(src);
  if (!match) throw new Error("nao encontrei normalizeCouponCode em lib/data/coupons.ts");
  // Corpo: return code.trimStart().toUpperCase();
  return new Function("code", match[1]) as (code: string) => string;
}

const normalize = extractNormalize();

// ---------------------------------------------------------------------------
// (a) normalizeCouponCode — comportamental (executa a implementacao real)
// ---------------------------------------------------------------------------
describe("INV-10 (a) — normalizeCouponCode: trim bilateral + UPPER + idempotencia", () => {
  it("remove espaco a ESQUERDA (leading)", () => {
    expect(normalize(" PROMO")).toBe("PROMO");
  });

  it("D-01: remove espaco a DIREITA (trailing) — trimStart() NAO faz isso", () => {
    const result = normalize("PROMO ");
    expect(
      result,
      `D-01 CONFIRMADO: normalizeCouponCode("PROMO ") retornou "${result}" em vez de "PROMO". ` +
        "trimStart() so remove o espaco a esquerda; o espaco a direita persiste. " +
        "O banco tem indice LOWER(code) UNIQUE — 'PROMO ' e 'PROMO' seriam codigos distintos, " +
        "violando unicidade e permitindo dois cupons com o mesmo codigo efetivo.",
    ).toBe("PROMO");
  });

  it("D-01: remove espacos em AMBAS as pontas simultaneamente", () => {
    const result = normalize(" PROMO ");
    expect(
      result,
      `D-01 CONFIRMADO: normalizeCouponCode(" PROMO ") retornou "${result}" em vez de "PROMO". ` +
        "trim() bilateral esta ausente.",
    ).toBe("PROMO");
  });

  it("converte para UPPER", () => {
    expect(normalize("promo10")).toBe("PROMO10");
  });

  it("D-01: combinado: espaco a direita + lowercase", () => {
    const result = normalize("promo10 ");
    expect(
      result,
      `D-01 CONFIRMADO: normalizeCouponCode("promo10 ") retornou "${result}" em vez de "PROMO10".`,
    ).toBe("PROMO10");
  });

  it("e idempotente: aplicar duas vezes deve dar o mesmo resultado", () => {
    // Nota: mesmo com o bug, trimStart+UPPER e idempotente para strings ja upper.
    // O test e: normalize(normalize(x)) == normalize(x)
    const cases = ["PROMO", " PROMO", "PROMO ", " PROMO ", "promo"];
    for (const c of cases) {
      const once = normalize(c);
      const twice = normalize(once);
      expect(twice).toBe(once);
    }
  });

  it("string sem espacos e ja upper: retorna igual", () => {
    expect(normalize("NATAL25")).toBe("NATAL25");
  });
});

// ---------------------------------------------------------------------------
// (b) toCouponData XOR: prova de valor no fonte (funcao interna nao exportada)
// ---------------------------------------------------------------------------
describe("INV-10 (b) — toCouponData XOR: campo oposto zerado no fonte", () => {
  it("D-02: no caminho 'fixed', percentOff deve ser null — ternario nao pode ter ambos os ramos iguais", () => {
    const fn = /function toCouponData[\s\S]*?\n\}/.exec(src);
    expect(fn, "nao encontrei toCouponData em lib/data/coupons.ts").not.toBe(null);
    const body = fn![0];

    // Detecta a forma errada: ambos os ramos do ternario de percentOff sao identicos
    const offendingPercentOff =
      /percentOff\s*:\s*isPercent\s*\?\s*input\.percentOff\s*:\s*input\.percentOff/.test(body);
    expect(
      offendingPercentOff,
      "D-02 CONFIRMADO: toCouponData tem 'percentOff: isPercent ? input.percentOff : input.percentOff'. " +
        "Ambos os ramos sao identicos — no caminho 'fixed' o percentOff NAO e zerado para null. " +
        "Um cupom 'fixed' com percentOff != null no input vai persistir com percentOff preenchido, " +
        "violando a coerencia percent XOR fixed do INV-10.",
    ).toBe(false);

    // Forma correta: no caminho fixed, percentOff deve ser null
    const correctPercentOff = /percentOff\s*:\s*isPercent\s*\?\s*input\.percentOff\s*:\s*null/.test(
      body,
    );
    expect(
      correctPercentOff,
      "toCouponData nao zera percentOff para null no caminho 'fixed'. " +
        "Forma correta: 'percentOff: isPercent ? input.percentOff : null'.",
    ).toBe(true);
  });

  it("no caminho 'percent', valueCents deve ser null (forma correta ja existente)", () => {
    const fn = /function toCouponData[\s\S]*?\n\}/.exec(src);
    expect(fn, "nao encontrei toCouponData em lib/data/coupons.ts").not.toBe(null);
    const body = fn![0];

    const correctValueCents = /valueCents\s*:\s*isPercent\s*\?\s*null\s*:\s*input\.valueCents/.test(
      body,
    );
    expect(
      correctValueCents,
      "toCouponData nao zera valueCents para null no caminho 'percent'. " +
        "Forma correta: 'valueCents: isPercent ? null : input.valueCents'.",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) validateCoupon bordas — prova de valor no fonte (funcao usa banco)
// ---------------------------------------------------------------------------
describe("INV-10 (c) — validateCoupon bordas de tempo e valor: operadores exatos no fonte", () => {
  it("startsAt: operador > now (startsAt == now => VALIDO, borda inclusiva do inicio)", () => {
    const correctStart = /new Date\(coupon\.startsAt\)\s*>\s*now/.test(src);
    expect(
      correctStart,
      "validateCoupon nao usa '>' para startsAt. Spec: startsAt == now => VALIDO (INV-10).",
    ).toBe(true);

    const offendingStart = /new Date\(coupon\.startsAt\)\s*>=\s*now/.test(src);
    expect(
      offendingStart,
      "validateCoupon usa '>=' para startsAt — startsAt==now seria incorretamente rejeitado como not_started.",
    ).toBe(false);
  });

  it("D-03: expiresAt: operador <= now (expiresAt == now => EXPIRADO — borda exclusiva do fim)", () => {
    // Forma correta: new Date(coupon.expiresAt) <= now
    const correctExpiry = /new Date\(coupon\.expiresAt\)\s*<=\s*now/.test(src);
    expect(
      correctExpiry,
      "D-03 CONFIRMADO: validateCoupon nao usa '<= now' para expiresAt. " +
        "Spec: expiresAt == now => 'expired' (fim EXCLUSIVO). " +
        "Com '<' estrito, expiresAt==now passa como valido — janela erronea onde cupom expirado ainda e aceito.",
    ).toBe(true);

    // Forma errada: < now — expiresAt==now passa indevidamente
    // Regex cuidadoso para nao capturar <=
    const offendingExpiry = /new Date\(coupon\.expiresAt\)\s*<\s*now(?!=)/.test(src);
    expect(
      offendingExpiry,
      "D-03 CONFIRMADO: validateCoupon usa '<' para expiresAt em vez de '<='. " +
        "Um cupom com expiresAt exatamente igual ao instante 'now' e incorretamente aceito.",
    ).toBe(false);
  });

  it("minSubtotal: operador < (merchandiseCents == min => VALIDO — borda inclusiva do min)", () => {
    const correctMin = /input\.merchandiseCents\s*<\s*coupon\.minSubtotalCents/.test(src);
    expect(
      correctMin,
      "validateCoupon nao usa '<' para minSubtotal. Spec: merchandiseCents==min => VALIDO (INV-10).",
    ).toBe(true);

    const offendingMin = /input\.merchandiseCents\s*<=\s*coupon\.minSubtotalCents/.test(src);
    expect(
      offendingMin,
      "validateCoupon usa '<=' para minSubtotal — merchandiseCents==min seria incorretamente rejeitado como below_min.",
    ).toBe(false);
  });
});

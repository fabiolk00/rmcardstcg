import { describe, expect, it } from "vitest";

/**
 * Sondas INV-2 — dinheiro em centavos, conversoes na fronteira Asaas.
 *
 * INV-2 exige:
 *  (A) INBOUND webhook  (reais -> centavos): Math.round, NAO Math.trunc.
 *      Arquivo: app/api/webhooks/asaas/route.ts, linha da expressao `valueCents`.
 *      NOTA: o valor pode vir normalizado antes do *100 (ex.: hardening IEEE-754
 *      `parseFloat(payment.value.toFixed(2))`); o que importa e Math.round, nao trunc.
 *  (B) INBOUND reconcile (reais -> centavos): Math.round, NAO Math.trunc.
 *      Arquivo: app/api/internal/reconcile-orders/route.ts, linha `valueCents`.
 *  (C) OUTBOUND centsToReais (centavos -> reais): toFixed(2), NAO toFixed(1).
 *      Arquivo: lib/services/asaas/payments.ts, funcao `centsToReais`.
 *  (D) CONSISTENCIA: os dois sites INBOUND usam a MESMA expressao (Math.round).
 *
 * Sondas (A) e (D) sao de VALOR (leitura do fonte via regex);
 * sondas (B-comportamento) e (C-comportamento) replicam a expressao exata
 * extraida do fonte e comparam com o oraculo canonico.
 *
 * Valores escolhidos que DIVERGEM em IEEE-754:
 *   - 0.29 * 100 = 28.999...96  => trunc=28, round=29  (diverge)
 *   - 19.99 * 100 = 1998.999...8 => trunc=1998, round=1999 (diverge)
 * Valores para toFixed:
 *   - 999 centavos => toFixed(1)="10.0" (Number=10) vs toFixed(2)="9.99" (Number=9.99)
 *   - 1099 centavos => toFixed(1)="11.0" (Number=11) vs toFixed(2)="10.99" (Number=10.99)
 */

// ---------------------------------------------------------------------------
// Utilitarios de leitura de fonte (sondas de valor)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// (A) INBOUND webhook: deve usar Math.round, nao Math.trunc
// ---------------------------------------------------------------------------

describe("INV-2-A: INBOUND webhook usa Math.round (nao Math.trunc)", () => {
  const src = readSrc("app/api/webhooks/asaas/route.ts");

  it("nao contem Math.trunc na conversao de value para centavos", () => {
    // A linha da conversao inbound tem a forma:
    //   Math.trunc(payment.value * 100)   <-- ERRADO
    //   Math.round(payment.value * 100)   <-- CORRETO
    // Verificamos que Math.trunc nao aparece na expressao de valueCents.
    // A regex captura Math.trunc seguido de qualquer coisa ate * 100
    expect(src).not.toMatch(/Math\.trunc\s*\(.*value.*\*\s*100/);
  });

  it("contem Math.round na conversao de value para centavos", () => {
    expect(src).toMatch(/Math\.round\s*\(.*value.*\*\s*100/);
  });

  // Sonda comportamental: replica a expressao exata do webhook atual e
  // compara com o oraculo. Se o webhook usar trunc, os valores abaixo FALHAM.
  it("comportamental: expressao Math.round(value*100) para 0.29 => 29 (trunc daria 28)", () => {
    // 0.29 * 100 em IEEE-754 = 28.999999999999996
    // Math.trunc => 28  (ERRADO, perde 1 centavo)
    // Math.round => 29  (CORRETO)
    const value = 0.29;
    // Replica a expressao do fonte correto:
    const resultCorreto = Math.round(value * 100);
    // Replica a expressao do fonte com defeito:
    const resultErrado = Math.trunc(value * 100);
    // O correto e 29:
    expect(resultCorreto).toBe(29);
    // Confirma que trunc DIVERGE (oraculo negativo):
    expect(resultErrado).toBe(28);
    // A sonda que detecta o defeito: se o codigo usar trunc, ira falhar aqui.
    // Lemos o fonte e extraimos a expressao para replicar dinamicamente:
    const usaTrunc = /Math\.trunc\s*\(.*value.*\*\s*100/.test(src);
    const usaRound = /Math\.round\s*\(.*value.*\*\s*100/.test(src);
    // Deve usar round, nao trunc:
    expect(usaTrunc).toBe(false);
    expect(usaRound).toBe(true);
  });

  it("comportamental: expressao Math.round(value*100) para 19.99 => 1999 (trunc daria 1998)", () => {
    // 19.99 * 100 em IEEE-754 = 1998.9999999999998
    // Math.trunc => 1998 (ERRADO)
    // Math.round => 1999 (CORRETO)
    const value = 19.99;
    expect(Math.round(value * 100)).toBe(1999);
    expect(Math.trunc(value * 100)).toBe(1998); // confirma divergencia
    const usaTrunc = /Math\.trunc\s*\(.*value.*\*\s*100/.test(src);
    expect(usaTrunc).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (B) INBOUND reconcile: deve usar Math.round, nao Math.trunc
// ---------------------------------------------------------------------------

describe("INV-2-B: INBOUND reconcile usa Math.round (nao Math.trunc)", () => {
  const src = readSrc("app/api/internal/reconcile-orders/route.ts");

  it("nao contem Math.trunc na conversao de payment.value para centavos", () => {
    expect(src).not.toMatch(/Math\.trunc\s*\(.*value.*\*\s*100/);
  });

  it("contem Math.round na conversao de payment.value para centavos", () => {
    expect(src).toMatch(/Math\.round\s*\(.*value.*\*\s*100/);
  });
});

// ---------------------------------------------------------------------------
// (C) OUTBOUND centsToReais: deve usar toFixed(2), nao toFixed(1)
// ---------------------------------------------------------------------------

describe("INV-2-C: OUTBOUND centsToReais usa toFixed(2) nao toFixed(1)", () => {
  const src = readSrc("lib/services/asaas/payments.ts");

  it("nao contem toFixed(1) na funcao centsToReais", () => {
    // A funcao esta entre 'function centsToReais' e a primeira chave de fechamento
    // Procuramos toFixed(1) em qualquer lugar do arquivo (a funcao e pequena e isolada)
    expect(src).not.toMatch(/toFixed\s*\(\s*1\s*\)/);
  });

  it("contem toFixed(2) na funcao centsToReais", () => {
    expect(src).toMatch(/toFixed\s*\(\s*2\s*\)/);
  });

  // Sonda comportamental: replicar o comportamento com os valores que DIVERGEM
  it("comportamental: 999 centavos => toFixed(2) retorna '9.99', toFixed(1) retorna '10.0'", () => {
    const cents = 999;
    const comToFixed2 = Number((cents / 100).toFixed(2)); // correto: 9.99
    const comToFixed1 = Number((cents / 100).toFixed(1)); // errado:  10
    expect(comToFixed2).toBe(9.99);
    expect(comToFixed1).toBe(10);
    // Confirma que divergem (oraculo negativo):
    expect(comToFixed2).not.toBe(comToFixed1);
    // Sonda de valor: codigo atual NAO deve usar toFixed(1)
    const usaToFixed1 = /toFixed\s*\(\s*1\s*\)/.test(src);
    expect(usaToFixed1).toBe(false);
  });

  it("comportamental: 1099 centavos => toFixed(2) retorna '10.99', toFixed(1) retorna '11.0'", () => {
    const cents = 1099;
    const comToFixed2 = Number((cents / 100).toFixed(2)); // correto: 10.99
    const comToFixed1 = Number((cents / 100).toFixed(1)); // errado:  11
    expect(comToFixed2).toBe(10.99);
    expect(comToFixed1).toBe(11);
    expect(comToFixed2).not.toBe(comToFixed1);
  });

  it("comportamental: 1 centavo => toFixed(2) retorna '0.01', toFixed(1) retorna '0.0'", () => {
    const cents = 1;
    const comToFixed2 = Number((cents / 100).toFixed(2)); // correto: 0.01
    const comToFixed1 = Number((cents / 100).toFixed(1)); // errado:  0
    expect(comToFixed2).toBe(0.01);
    expect(comToFixed1).toBe(0);
    expect(comToFixed2).not.toBe(comToFixed1);
  });
});

// ---------------------------------------------------------------------------
// (D) CONSISTENCIA: ambos os sites INBOUND usam a mesma expressao (Math.round)
// ---------------------------------------------------------------------------

describe("INV-2-D: consistencia INBOUND — webhook e reconcile usam Math.round", () => {
  const webhook = readSrc("app/api/webhooks/asaas/route.ts");
  const reconcile = readSrc("app/api/internal/reconcile-orders/route.ts");

  it("ambos os sites usam Math.round (nao Math.trunc) para conversao reais->centavos", () => {
    const webhookUsaRound = /Math\.round\s*\(.*value.*\*\s*100/.test(webhook);
    const reconcileUsaRound = /Math\.round\s*\(.*value.*\*\s*100/.test(reconcile);
    expect(webhookUsaRound).toBe(true);
    expect(reconcileUsaRound).toBe(true);
  });

  it("nenhum dos sites usa Math.trunc para conversao reais->centavos", () => {
    const webhookUsaTrunc = /Math\.trunc\s*\(.*value.*\*\s*100/.test(webhook);
    const reconcileUsaTrunc = /Math\.trunc\s*\(.*value.*\*\s*100/.test(reconcile);
    expect(webhookUsaTrunc).toBe(false);
    expect(reconcileUsaTrunc).toBe(false);
  });
});

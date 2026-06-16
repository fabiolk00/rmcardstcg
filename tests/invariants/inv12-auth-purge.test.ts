import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Sondas INV-12 — tres facetas:
 *  (a) RECONCILIACAO so toca 'pending' (coberta por D-03 de INV-8; confirmada aqui
 *      via leitura direta de reconciliation.ts).
 *  (b) AUTH constant-time fail-closed em route.ts:
 *      secretMatches DEVE usar timingSafeEqual e NAO usar === / !== para comparar
 *      segredos; deve ser fail-closed (sem segredo no servidor => false antes de
 *      comparar); a rota deve retornar 500 sem env e 401 com segredo errado.
 *  (c) PURGE de retencao em migration.sql:
 *      DELETE so de "webhook_events" (nunca "audit_log"), com processed_at IS NOT
 *      NULL E processed_at < (now() - interval '90 days') — operador < (apaga
 *      antigo); um > apagaria dados recentes.
 *
 * Defeitos alvo desta suite (introducidos em chaos/inv-12-1):
 *  D-01 route.ts: secretMatches usa `===` (short-circuit) apos construir Buffers —
 *       timingSafeEqual e importado mas nunca chamado.
 *  D-02 migration.sql: purge_processed_webhook_events usa `>` em vez de `<` —
 *       apaga webhook_events RECENTES (< 90 dias) em vez dos antigos.
 *
 * TIPO DE SONDA: de-valor (leitura de texto-fonte / regex).
 * Validacao verde-no-canonico: descrita inline em cada it().
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// ---------------------------------------------------------------------------
// INV-12(a) — reconciliation.ts filtra SOMENTE 'pending'
// (cobertura ja existente em inv8, repetida aqui para completude de INV-12)
// ---------------------------------------------------------------------------
describe("INV-12(a) (valor) — reconciliation.ts filtra SOMENTE pending", () => {
  const reconcSrc = read("lib/data/reconciliation.ts");

  it("paymentStatus filtro e exatamente a string 'pending', nao { in: [...] }", () => {
    const correctForm = /paymentStatus\s*:\s*["']pending["']/.test(reconcSrc);
    const offendingForm = /paymentStatus\s*:\s*\{[^}]*in\s*:/.test(reconcSrc);
    expect(
      offendingForm,
      "INV-12(a): reconciliation.ts usa paymentStatus: { in: [...] } — reconciliacao pode tocar pedidos 'paid'.",
    ).toBe(false);
    expect(
      correctForm,
      "INV-12(a): reconciliation.ts nao contem paymentStatus: 'pending' — predicado correto ausente.",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-12(b) — AUTH constant-time fail-closed em route.ts
// ---------------------------------------------------------------------------
describe("INV-12(b) AUTH (valor) — secretMatches usa timingSafeEqual, nao ===", () => {
  const routeSrc = read("app/api/internal/reconcile-orders/route.ts");

  /**
   * D-01 ALVO:
   *   return a.length === b.length && received === expected;
   *              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
   *   O timingSafeEqual e importado mas nao chamado. A comparacao com === vaza
   *   timing (curto-circuito em caractere diferente).
   *
   * Canonico correto:
   *   return a.length === b.length && timingSafeEqual(a, b);
   */

  it("D-01 (valor): secretMatches NAO usa '===' para comparar os segredos (received === expected)", () => {
    // Detecta a forma errada: comparacao direta de strings received === expected
    // ou expected === received (commutativo).
    // Nota: a.length === b.length e ok (comparar comprimentos nao vaza conteudo).
    // O problema e comparar os CONTEUDOS das strings diretamente.
    const offendingPattern =
      /received\s*===\s*expected|expected\s*===\s*received|received\s*!==\s*expected|expected\s*!==\s*received/;
    const hasOffending = offendingPattern.test(routeSrc);
    expect(
      hasOffending,
      "D-01 CONFIRMADO: secretMatches usa '===' para comparar segredos (received === expected) — comparacao em tempo nao-constante; timingSafeEqual e importado mas nao chamado.",
    ).toBe(false);
  });

  it("D-01 (valor): secretMatches chama timingSafeEqual(a, b) para comparar conteudo", () => {
    // Forma correta: timingSafeEqual(a, b) ou timingSafeEqual(b, a)
    const correctPattern = /timingSafeEqual\s*\(\s*[ab]\s*,\s*[ab]\s*\)/.test(routeSrc);
    expect(
      correctPattern,
      "D-01 CONFIRMADO: secretMatches nao chama timingSafeEqual(a, b) — a funcao e importada mas nao usada na comparacao de conteudo.",
    ).toBe(true);
  });

  it("(valor): fail-closed — sem segredo no servidor, secretMatches retorna false", () => {
    // Forma correta: if (!expected || !received) return false
    // Qualquer variante de guarda que retorna false (nao true) quando expected/received ausente.
    const failClosedPattern = /if\s*\(\s*!expected\s*\|\|\s*!received\s*\)\s*return\s*false/.test(
      routeSrc,
    );
    expect(
      failClosedPattern,
      "fail-closed ausente: secretMatches deve retornar false quando !expected || !received.",
    ).toBe(true);
  });

  it("(valor): rota retorna 500 quando CRON_RECONCILE_SECRET nao esta definida no servidor", () => {
    // Verifica que a rota POST checa process.env.CRON_RECONCILE_SECRET e retorna status 500.
    const has500Guard = /CRON_RECONCILE_SECRET/.test(routeSrc) && /status:\s*500/.test(routeSrc);
    expect(has500Guard, "rota nao tem guarda 500 para CRON_RECONCILE_SECRET ausente.").toBe(true);
  });

  it("(valor): rota retorna 401 quando secretMatches retorna false", () => {
    const has401 = /status:\s*401/.test(routeSrc);
    expect(has401, "rota nao retorna 401 para segredo errado/ausente.").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-12(c) — PURGE retencao em migration.sql
// ---------------------------------------------------------------------------
describe("INV-12(c) PURGE (valor) — purge_processed_webhook_events apaga antigos, nao recentes", () => {
  const sqlSrc = read("prisma/migrations/20260615060000_pgcron/migration.sql");

  /**
   * D-02 ALVO:
   *   AND "processed_at" > (now() - interval '90 days')
   *                      ^
   *   Operador > significa: processed_at MAIS RECENTE que (now()-90d)
   *   => apaga os RECENTES (< 90 dias). Isso e o inverso do pretendido.
   *
   * Canonico correto:
   *   AND "processed_at" < (now() - interval '90 days')
   *                      ^
   *   => apaga apenas os ANTIGOS (mais de 90 dias atras).
   */

  it("D-02 (valor): purge usa operador '<' (apaga antigo), NAO '>'  (apagaria recente)", () => {
    // Extrai o bloco da funcao purge_processed_webhook_events
    const purgeBlock =
      /CREATE OR REPLACE FUNCTION purge_processed_webhook_events[\s\S]*?\$\$;/m.exec(sqlSrc);
    expect(purgeBlock, "nao encontrei purge_processed_webhook_events no SQL").not.toBe(null);

    const block = purgeBlock![0];

    // Operador errado: > (apaga recente)
    const hasGt = /processed_at"\s*>/.test(block);
    // Operador correto: < (apaga antigo)
    const hasLt = /processed_at"\s*</.test(block);

    expect(
      hasGt,
      "D-02 CONFIRMADO: purge_processed_webhook_events usa 'processed_at > (now()-90d)' — apaga webhook_events RECENTES (menos de 90 dias), destruindo dados dentro da janela de retencao.",
    ).toBe(false);

    expect(
      hasLt,
      "D-02 CONFIRMADO: purge_processed_webhook_events nao usa 'processed_at < (now()-90d)' — operador correto ausente.",
    ).toBe(true);
  });

  it("(valor): DELETE alvo e 'webhook_events', nunca 'audit_log'", () => {
    const purgeBlock =
      /CREATE OR REPLACE FUNCTION purge_processed_webhook_events[\s\S]*?\$\$;/m.exec(sqlSrc);
    expect(purgeBlock, "nao encontrei purge_processed_webhook_events no SQL").not.toBe(null);
    const block = purgeBlock![0];

    // Deve deletar de webhook_events
    const deletesWebhook = /DELETE FROM\s+"webhook_events"/.test(block);
    // Nao deve deletar de audit_log
    const deletesAudit = /DELETE FROM\s+"audit_log"/.test(block);

    expect(
      deletesWebhook,
      "purge nao deleta de 'webhook_events' — tabela alvo incorreta ou ausente.",
    ).toBe(true);
    expect(
      deletesAudit,
      "CRITICO: purge deleta de 'audit_log' — viola INV-7 (auditoria imutavel).",
    ).toBe(false);
  });

  it("(valor): DELETE inclui condicao processed_at IS NOT NULL", () => {
    const purgeBlock =
      /CREATE OR REPLACE FUNCTION purge_processed_webhook_events[\s\S]*?\$\$;/m.exec(sqlSrc);
    expect(purgeBlock, "nao encontrei purge_processed_webhook_events no SQL").not.toBe(null);
    const block = purgeBlock![0];

    const hasIsNotNull = /processed_at"\s+IS\s+NOT\s+NULL/.test(block);
    expect(
      hasIsNotNull,
      "purge nao filtra processed_at IS NOT NULL — pode apagar webhook_events ainda nao processados.",
    ).toBe(true);
  });

  it("(valor): intervalo de retencao e '90 days' (nao menos)", () => {
    const purgeBlock =
      /CREATE OR REPLACE FUNCTION purge_processed_webhook_events[\s\S]*?\$\$;/m.exec(sqlSrc);
    expect(purgeBlock, "nao encontrei purge_processed_webhook_events no SQL").not.toBe(null);
    const block = purgeBlock![0];

    const has90Days = /interval\s+'90 days'/.test(block);
    expect(has90Days, "purge nao usa intervalo '90 days' — janela de retencao incorreta.").toBe(
      true,
    );
  });
});

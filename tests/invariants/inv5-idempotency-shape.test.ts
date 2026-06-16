import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Sondas de FORMA (estaticas, sem banco) para o INV-5 — idempotencia em escrita
// externa: ledger (provider,event_id) unico + anti-replay + CAS, TUDO na MESMA
// transacao do efeito. Reenviar o mesmo evento do Asaas (sequencial OU concorrente)
// tem que dar estado identico e estoque baixado exatamente uma vez.
//
// Por que sondas de forma e nao so de runtime: a prova de runtime do INV-5 mora
// nos testes de concorrencia (tests/concurrency/*) que sao describe.skipIf(
// !TEST_DATABASE_URL) — DORMENTES sem um Postgres efemero. Estas sondas pegam, sem
// banco, as CLASSES de mutacao que corroem o INV-5 silenciosamente (typecheck e
// build passam): cliente errado na escrita do ledger, guard de CAS removido,
// insert do ledger trocado por read-then-write nao-atomico. Sao a rede barata; a
// rede definitiva e a suite de concorrencia rodando contra Postgres efemero na CI.

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("INV-5 (forma) — idempotencia transacional do webhook", () => {
  // CH-5101: markWebhookEventProcessed(prisma, ...) em vez de tx => o processed_at
  // e commitado FORA da transacao do efeito; rollback do efeito deixa o evento
  // "processado" sem efeito, e o reenvio vira no-op (efeito perdido).
  it("escritas do ledger usam o TransactionClient (tx), nunca o prisma global", () => {
    const route = read("app/api/webhooks/asaas/route.ts");
    for (const fn of [
      "recordWebhookEvent",
      "markWebhookEventProcessed",
      "isWebhookEventProcessed",
    ]) {
      // Dentro do callback de prisma.$transaction, estas funcoes do ledger so podem
      // receber `tx`. Passar `prisma` quebra a atomicidade (conexao autocommit).
      const offending = new RegExp(`${fn}\\s*\\(\\s*prisma\\b`);
      expect(
        offending.test(route),
        `${fn} recebe o prisma global (autocommit) em vez de tx — quebra a atomicidade ledger+efeito (INV-5)`,
      ).toBe(false);
    }
  });

  // CH-5102: o CAS de commit de estoque (status 'paid') perdeu "stock_committed" =
  // false do WHERE => deixa de ser idempotente por flag, abrindo dupla-baixa.
  it("o CAS de commit de estoque preserva o guard duplo (reserved=true AND committed=false)", () => {
    const orders = read("lib/data/orders.ts");
    // Bloco do UPDATE que faz o commit de estoque no caminho 'paid'.
    const block = /UPDATE\s+"orders"\s+SET\s+"stock_committed"\s*=\s*true[\s\S]{0,200}?`/.exec(
      orders,
    );
    expect(
      block,
      "nao encontrei o CAS de commit de estoque ('paid') em lib/data/orders.ts",
    ).not.toBe(null);
    const sql = block![0];
    expect(
      /"stock_reserved"\s*=\s*true/.test(sql),
      'CAS de commit sem `"stock_reserved" = true` no WHERE (INV-5/INV-6)',
    ).toBe(true);
    expect(
      /"stock_committed"\s*=\s*false/.test(sql),
      'CAS de commit sem `"stock_committed" = false` no WHERE — remove a trava anti-dupla-baixa (INV-5/INV-6)',
    ).toBe(true);
  });

  // CH-5103: recordWebhookEvent trocou o INSERT ... ON CONFLICT DO NOTHING atomico
  // (createMany + skipDuplicates) por findUnique-depois-create => TOCTOU: dois
  // eventos concorrentes com o mesmo event_id ambos leem null e ambos aplicam.
  it("recordWebhookEvent insere o evento de forma atomica (sem read-then-write)", () => {
    const wh = read("lib/data/webhookEvents.ts");
    const fn = /export async function recordWebhookEvent[\s\S]*?\n}/.exec(wh);
    expect(fn, "nao encontrei recordWebhookEvent em lib/data/webhookEvents.ts").not.toBe(null);
    const body = fn![0];
    expect(
      /skipDuplicates\s*:\s*true/.test(body),
      "recordWebhookEvent sem `skipDuplicates: true` — perde o INSERT ON CONFLICT DO NOTHING atomico (INV-5)",
    ).toBe(true);
    expect(
      /findUnique/.test(body),
      "recordWebhookEvent usa findUnique antes do insert (read-then-write TOCTOU) — anti-replay deixa de ser atomico (INV-5)",
    ).toBe(false);
  });
});

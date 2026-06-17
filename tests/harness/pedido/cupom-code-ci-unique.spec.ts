import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.code.ci-unique (priority 20) — DB-first, sem browser.
 *
 * Prova "codigo de cupom e unico case-insensitive (LOWER(code))" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * cupom-create-percent.spec.ts / cupom-create-fixed.spec.ts: roda em Node (sem `page`)
 * e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: createCoupon(actor, input) de lib/data/coupons.ts (L150) — a funcao
 * de PRODUCAO de MENOR NIVEL que prova as invariantes. Numa MESMA prisma.$transaction
 * ela normaliza o code via normalizeCouponCode (trim + UPPER), faz tx.coupon.create e
 * grava audit_log na mesma tx; um codigo que ja existe em QUALQUER caixa colide no
 * indice funcional UNIQUE (LOWER(code)) coupons_code_key (P2002) e a funcao trata como
 * { ok:false, error } SEM gravar audit (rollback da $transaction). NAO chamamos a
 * server action createCouponAction porque ela comeca com requireAdmin() (contexto de
 * request: next/headers, Clerk), que quebra fora do HTTP; a action so DELEGA para
 * createCoupon. O seam `createCoupon` (tests/harness/estoque/_run-seam.ts) JA existe —
 * runner NAO precisou ser estendido nesta sessao.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a MUTACAO (createCoupon) roda num processo `tsx` separado (_run-seam.ts, case
 * `createCoupon`), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * ANTI-TRIVIALIDADE: a primeira criacao usa um code com caixa MISTA (ex. AbC...) e a
 * segunda usa o MESMO code todo em minusculas. Se o indice fosse case-sensitive (ou se
 * normalizeCouponCode falhasse), as duas linhas coexistiriam — o assert "1 unica linha
 * para LOWER(code)" pega exatamente essa regressao. O delta de audit_log e medido
 * GLOBAL e POR-entity p/ provar que a criacao falha nao deixou orfao (rollback).
 *
 * Invariantes cobertas:
 *  - coupon-code-ci-unique: indice funcional UNIQUE (LOWER(code)) coupons_code_key
 *    rejeita o mesmo codigo em outra caixa (P2002 tratado -> {ok:false}); 1 unica linha
 *    para esse LOWER(code); code armazenado normalizado em UPPER (normalizeCouponCode).
 *  - audit-same-tx: a criacao FALHA nao grava audit_log (rollback da $transaction);
 *    delta global == +1 (so a 1a criacao bem-sucedida), delta por entity_id do 2o code
 *    == 0.
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type CreateCouponResult =
  | { ok: false; error: string }
  | { ok: true; coupon: { id: string; code: string; type: string } };

/** Chama uma op do seam via processo tsx; devolve a linha __SEAM_RESULT__ parseada. */
function runSeam<T>(op: string, payload: unknown): T {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
    encoding: "utf8",
    // Herda DATABASE_URL do runner; payload via env (nao argv) p/ nao depender do
    // quoting de JSON pelo shell do Windows.
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32", // resolve .cmd no Windows
  });
  const out = `${r.stdout ?? ""}`;
  if (r.status !== 0 && !out.includes("__SEAM_")) {
    throw new Error(`seam runner falhou (status ${r.status}):\n${out}\n${r.stderr ?? ""}`);
  }
  const okLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
  const errLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
  if (errLine) {
    const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
    throw new Error(`${e.name}: ${e.message}`);
  }
  if (!okLine) throw new Error(`seam runner sem resultado:\n${out}\n${r.stderr ?? ""}`);
  return JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as T;
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

/** Input de cupom valido (percent) parametrizado so pelo code. */
function couponInput(code: string) {
  return {
    code,
    type: "percent" as const,
    percentOff: 10,
    valueCents: null,
    minSubtotalCents: 0,
    maxRedemptions: null,
    perUserLimit: null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  };
}

const ACTOR = { clerkUserId: null, email: null, role: null };

test("cupom.code.ci-unique: o mesmo codigo em outra caixa colide no indice LOWER(code), e tratado (ok:false) e nao audita", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- sanity: o indice funcional UNIQUE coupons_code_key existe e e em LOWER(code).
    //     Sem ele, toda a feature seria vacua. indexdef expoe a definicao real do indice.
    const idx = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'coupons_code_key'`,
    );
    expect(idx.rowCount, "indice coupons_code_key deve existir").toBe(1);
    expect(idx.rows[0].indexdef, "coupons_code_key deve ser UNIQUE").toMatch(/UNIQUE/i);
    expect(idx.rows[0].indexdef, "coupons_code_key deve indexar LOWER(code)").toMatch(
      /lower\(\(?code\)?(::text)?\)/i,
    );

    // --- passo 0: contagens iniciais (audit_log global A).
    const before = await client.query<{ audit: string }>(
      `SELECT (SELECT COUNT(*) FROM "audit_log")::text AS audit`,
    );
    const A = Number(before.rows[0].audit);

    // --- passo 1: cria cupom com code de CAIXA MISTA (ex. AbCdEf-VERAO10). id unico/run.
    //     O code canonico no DB sera o UPPER deste (normalizeCouponCode).
    const slug = randomUUID().slice(0, 8);
    const firstCode = `VeRaO10-${slug}`; // caixa mista DE PROPOSITO (anti-trivial)
    const canonicalCode = firstCode.toUpperCase();
    const lowerCode = firstCode.toLowerCase();

    const first = runSeam<CreateCouponResult>("createCoupon", {
      actor: ACTOR,
      input: couponInput(firstCode),
    });
    expect(first.ok, `1a criacao deveria ter sucesso: ${JSON.stringify(first)}`).toBe(true);
    if (!first.ok) throw new Error("inalcancavel");
    const firstId = first.coupon.id;
    expect(firstId, "1a criacao deve retornar o cupom criado").toBeTruthy();

    // --- assert: code armazenado normalizado em UPPER (normalizeCouponCode).
    const firstRow = await client.query<{ code: string }>(
      `SELECT code FROM "coupons" WHERE id = $1`,
      [firstId],
    );
    expect(firstRow.rowCount).toBe(1);
    expect(firstRow.rows[0].code, "code armazenado normalizado em UPPER").toBe(canonicalCode);
    // Sanity anti-trivial: a forma minuscula NAO foi gravada crua.
    expect(firstRow.rows[0].code).not.toBe(lowerCode);

    // audit_log da 1a criacao (sucesso) gravou exatamente 1 linha para esse cupom.
    const auditAfterFirst = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const AfterFirst = Number(auditAfterFirst.rows[0].count);
    expect(AfterFirst, "1a criacao audita exatamente 1 linha (sucesso)").toBe(A + 1);

    // --- passo 2: tenta criar OUTRO cupom com o MESMO code em minusculas. Deve colidir
    //     no indice LOWER(code) -> P2002 tratado -> { ok:false } com mensagem de duplicado.
    const second = runSeam<CreateCouponResult>("createCoupon", {
      actor: ACTOR,
      input: couponInput(lowerCode),
    });
    expect(second.ok, `2a criacao (mesmo code em minusculas) deveria FALHAR (P2002 tratado)`).toBe(
      false,
    );
    if (second.ok) throw new Error("inalcancavel: 2a criacao nao deveria ter sucesso");
    expect(second.error, "mensagem de codigo duplicado").toMatch(/c[oó]digo/i);

    // --- assert: existe 1 UNICA linha para esse LOWER(code) (indice UNIQUE funcionou;
    //     nenhuma 2a linha case-variante coexistindo).
    const countForCode = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupons" WHERE LOWER(code) = LOWER($1)`,
      [firstCode],
    );
    expect(
      Number(countForCode.rows[0].count),
      "1 unica linha para esse codigo (indice UNIQUE em LOWER(code))",
    ).toBe(1);

    // E essa unica linha e a 1a (mesmo id), ainda em UPPER canonico (a 2a nao sobrescreveu).
    const surviving = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM "coupons" WHERE LOWER(code) = LOWER($1)`,
      [firstCode],
    );
    expect(surviving.rows[0].id, "a linha sobrevivente e a 1a (mesmo id)").toBe(firstId);
    expect(surviving.rows[0].code, "code segue canonico em UPPER").toBe(canonicalCode);

    // --- assert: audit_log NAO ganhou linha pela criacao FALHA (rollback da tx).
    //     (1) delta GLOBAL == +1 no total (so a 1a criacao auditou).
    const auditAfterSecond = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfterSecond.rows[0].count),
      "audit_log nao cresce na criacao falha (so a 1a, bem-sucedida, auditou)",
    ).toBe(A + 1);

    // (2) Nenhuma linha de audit de coupon.create cujo snapshot 'after' aponte o code
    //     duplicado em qualquer caixa que NAO seja a 1a (orfao de rollback). Conta as
    //     linhas coupon.create cujo after->>code casa o LOWER(code) e exige exatamente 1
    //     (a da 1a criacao); zero orfaos da 2a.
    const auditForCode = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE action = 'coupon.create'
           AND LOWER(after->>'code') = LOWER($1)`,
      [firstCode],
    );
    expect(
      Number(auditForCode.rows[0].count),
      "exatamente 1 audit coupon.create para esse codigo (a falha nao deixou orfao)",
    ).toBe(1);
  } finally {
    await client.end();
  }
});

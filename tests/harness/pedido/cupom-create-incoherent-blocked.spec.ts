import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.create.incoherent-blocked (priority 19) — DB-first, sem browser.
 *
 * Prova "cupom incoerente (percent com value, ou fora de faixa) e barrado pelo CHECK"
 * contra o Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * cupom-create-percent.spec.ts / cupom-create-fixed.spec.ts: roda em Node (sem `page`)
 * e assertaa o estado real via `pg`.
 *
 * Esta feature tem DUAS frentes complementares, ambas exigidas pelos asserts:
 *
 *  (A) O CHECK coupons_type_value_chk e a REDE FINAL no DB. Os steps mandam "inserir
 *      DIRETO no DB" um cupom incoerente — por isso aqui NAO passamos pela funcao de
 *      dominio: fazemos INSERT cru via `pg` (savepoint por tentativa) e provamos que o
 *      Postgres REJEITA cada um pelo MESMO constraint (SQLSTATE 23514, conname
 *      coupons_type_value_chk). Casos:
 *        - type='percent', percent_off=150 (fora de 1..100), value_cents NULL;
 *        - type='fixed',   value_cents=0   (precisa > 0),    percent_off NULL.
 *      Nenhuma linha incoerente persiste (count inalterado + 0 violacoes na tabela).
 *
 *  (B) toCouponData no dominio SEMPRE casa tipo<->campo (o outro fica NULL). Provamos
 *      chamando a funcao de PRODUCAO createCoupon (lib/data/coupons.ts L150) via o seam
 *      `createCoupon` (tests/harness/estoque/_run-seam.ts — JA existente, runner NAO
 *      estendido), com input DE PROPOSITO incoerente no campo do tipo oposto:
 *        - type='percent' + valueCents=9999 (lixo)  -> persiste value_cents NULL;
 *        - type='fixed'   + percentOff=55  (lixo)   -> persiste percent_off NULL.
 *      Como toCouponData zera o campo do tipo oposto, o cupom resultante e COERENTE
 *      (passa pelo CHECK) — i.e. o dominio nunca tenta gravar o lixo que o CHECK barraria.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a frente (B) roda a mutacao num processo `tsx` separado (_run-seam.ts, case
 * `createCoupon`), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`. A
 * frente (A) e SQL cru, nao precisa de produto nenhum.
 *
 * Invariante coberta:
 *  - coupon-coherence: (A) o CHECK coupons_type_value_chk existe e REJEITA percent fora
 *    de 1..100 e fixed com value_cents<=0; nenhuma linha incoerente persiste. (B)
 *    toCouponData casa tipo<->campo (o outro fica NULL), entao o dominio so grava linhas
 *    coerentes.
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

/** Predicado real do CHECK coupons_type_value_chk (identico ao test-schema-supplement.sql L38-41). */
const VIOLATION_PREDICATE = `
  SELECT COUNT(*)::text AS count FROM "coupons"
    WHERE NOT (
      ("type" = 'percent' AND "percent_off" IS NOT NULL AND "percent_off" BETWEEN 1 AND 100)
      OR ("type" = 'fixed' AND "value_cents" IS NOT NULL AND "value_cents" > 0)
    )
`;

/**
 * Tenta um INSERT cru e devolve o erro do Postgres (ou null se — indevidamente — passou).
 * Usa um SAVEPOINT por tentativa p/ que a falha esperada nao envenene a transacao em volta.
 */
async function tryRawInsert(
  client: Client,
  cols: { code: string; type: string; percentOff: number | null; valueCents: number | null },
): Promise<{ code?: string; constraint?: string } | null> {
  await client.query("SAVEPOINT s_insert");
  try {
    // `id` e gerado pelo Prisma na aplicacao (@default(uuid())), NAO ha default no DB —
    // num INSERT cru precisamos fornecer um uuid, senao falharia por NOT NULL (23502)
    // ANTES de chegar ao CHECK que queremos exercitar.
    await client.query(
      `INSERT INTO "coupons" ("id","code","type","percent_off","value_cents")
         VALUES ($1, $2, $3::"CouponType", $4, $5)`,
      [randomUUID(), cols.code, cols.type, cols.percentOff, cols.valueCents],
    );
    await client.query("RELEASE SAVEPOINT s_insert");
    return null; // NAO deveria chegar aqui: o CHECK deveria ter rejeitado.
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s_insert");
    await client.query("RELEASE SAVEPOINT s_insert");
    const e = err as { code?: string; constraint?: string };
    return { code: e.code, constraint: e.constraint };
  }
}

test("cupom.create.incoherent-blocked: o CHECK coupons_type_value_chk rejeita percent fora de faixa e fixed com value<=0; dominio casa tipo<->campo", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // =====================================================================
    // FRENTE (A) — INSERT CRU direto no DB; o CHECK e a rede final.
    // =====================================================================

    // Sanity: o CHECK existe (sem ele a frente A seria vacua).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'coupons_type_value_chk'`,
    );
    expect(chk.rowCount, "CHECK coupons_type_value_chk deve existir").toBe(1);

    const before = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupons"`,
    );
    const N = Number(before.rows[0].count);

    // Tudo numa transacao com savepoints: as duas tentativas devem FALHAR e nada
    // persistir.
    await client.query("BEGIN");

    // (A1) percent com percent_off=150 (fora de 1..100), value_cents NULL.
    const percentOutOfRange = await tryRawInsert(client, {
      code: `harness-inc-pct-${randomUUID().slice(0, 8)}`,
      type: "percent",
      percentOff: 150,
      valueCents: null,
    });
    expect(
      percentOutOfRange,
      "INSERT percent com percent_off=150 deveria ser REJEITADO pelo CHECK (nao retornar null)",
    ).not.toBeNull();
    // 23514 = check_violation; o constraint exato deve ser coupons_type_value_chk.
    expect(percentOutOfRange?.code, "SQLSTATE de check_violation").toBe("23514");
    expect(percentOutOfRange?.constraint, "rejeitado pelo coupons_type_value_chk").toBe(
      "coupons_type_value_chk",
    );

    // (A2) fixed com value_cents=0 (precisa > 0), percent_off NULL.
    const fixedZeroValue = await tryRawInsert(client, {
      code: `harness-inc-fix-${randomUUID().slice(0, 8)}`,
      type: "fixed",
      percentOff: null,
      valueCents: 0,
    });
    expect(
      fixedZeroValue,
      "INSERT fixed com value_cents=0 deveria ser REJEITADO pelo CHECK (nao retornar null)",
    ).not.toBeNull();
    expect(fixedZeroValue?.code, "SQLSTATE de check_violation").toBe("23514");
    expect(fixedZeroValue?.constraint, "rejeitado pelo coupons_type_value_chk").toBe(
      "coupons_type_value_chk",
    );

    await client.query("COMMIT");

    // (A3) Nenhuma linha incoerente persistiu: count inalterado E 0 violacoes na tabela.
    const after = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupons"`,
    );
    expect(
      Number(after.rows[0].count),
      "nenhum cupom incoerente foi inserido (count inalterado)",
    ).toBe(N);
    const violationsA = await client.query<{ count: string }>(VIOLATION_PREDICATE);
    expect(
      Number(violationsA.rows[0].count),
      "nenhuma linha viola a coerencia type<->campo apos as tentativas",
    ).toBe(0);

    // =====================================================================
    // FRENTE (B) — toCouponData (PRODUCAO) sempre casa tipo<->campo: o campo do
    // tipo OPOSTO fica NULL, entao o dominio so grava linhas COERENTES.
    // =====================================================================

    // (B1) percent + valueCents lixo -> persiste value_cents NULL.
    const pctCode = `harness-coh-pct-${randomUUID().slice(0, 8)}`;
    const resPct = runSeam<CreateCouponResult>("createCoupon", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        code: pctCode,
        type: "percent" as const,
        percentOff: 25,
        valueCents: 9999, // ANTI-TRIVIAL: lixo do tipo oposto; toCouponData deve zerar.
        minSubtotalCents: 0,
        maxRedemptions: null,
        perUserLimit: null,
        isActive: true,
        startsAt: null,
        expiresAt: null,
      },
    });
    expect(resPct.ok, `createCoupon percent deveria ter sucesso: ${JSON.stringify(resPct)}`).toBe(
      true,
    );
    if (!resPct.ok) throw new Error("inalcancavel");

    const rowPct = await client.query<{
      type: string;
      percent_off: number | null;
      value_cents: number | null;
    }>(`SELECT type, percent_off, value_cents FROM "coupons" WHERE id = $1`, [resPct.coupon.id]);
    expect(rowPct.rowCount).toBe(1);
    expect(rowPct.rows[0].type).toBe("percent");
    expect(rowPct.rows[0].percent_off, "percent => percent_off preenchido").toBe(25);
    expect(
      rowPct.rows[0].value_cents,
      "percent => value_cents zerado (NULL) pela coerencia toCouponData",
    ).toBeNull();

    // (B2) fixed + percentOff lixo -> persiste percent_off NULL.
    const fixCode = `harness-coh-fix-${randomUUID().slice(0, 8)}`;
    const resFix = runSeam<CreateCouponResult>("createCoupon", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        code: fixCode,
        type: "fixed" as const,
        percentOff: 55, // ANTI-TRIVIAL: lixo do tipo oposto; toCouponData deve zerar.
        valueCents: 2500,
        minSubtotalCents: 0,
        maxRedemptions: null,
        perUserLimit: null,
        isActive: true,
        startsAt: null,
        expiresAt: null,
      },
    });
    expect(resFix.ok, `createCoupon fixed deveria ter sucesso: ${JSON.stringify(resFix)}`).toBe(
      true,
    );
    if (!resFix.ok) throw new Error("inalcancavel");

    const rowFix = await client.query<{
      type: string;
      percent_off: number | null;
      value_cents: number | null;
    }>(`SELECT type, percent_off, value_cents FROM "coupons" WHERE id = $1`, [resFix.coupon.id]);
    expect(rowFix.rowCount).toBe(1);
    expect(rowFix.rows[0].type).toBe("fixed");
    expect(rowFix.rows[0].value_cents, "fixed => value_cents preenchido").toBe(2500);
    expect(
      rowFix.rows[0].percent_off,
      "fixed => percent_off zerado (NULL) pela coerencia toCouponData",
    ).toBeNull();

    // Fechamento: mesmo apos as duas criacoes de dominio, a tabela inteira continua
    // SEM nenhuma linha incoerente (o dominio so gravou cupons coerentes).
    const violationsB = await client.query<{ count: string }>(VIOLATION_PREDICATE);
    expect(
      Number(violationsB.rows[0].count),
      "toCouponData mantem a tabela coerente (0 violacoes) apos criar percent e fixed",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

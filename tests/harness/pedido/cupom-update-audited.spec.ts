import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.update.audited (priority 21) — DB-first, sem browser.
 *
 * Prova "Admin edita cupom sem tocar redeemedCount (auditado)" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * cupom-create-percent.spec.ts / cupom-code-ci-unique.spec.ts: roda em Node (sem
 * `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: updateCoupon(actor, id, input) de lib/data/coupons.ts (L179) — a
 * funcao de PRODUCAO de MENOR NIVEL que prova as invariantes. Numa MESMA
 * prisma.$transaction ela le o cupom (before), normaliza o CouponInput via
 * toCouponData (mesma coerencia tipo<->campo do create — percent zera valueCents,
 * fixed zera percentOff; code em UPPER), faz tx.coupon.update e grava audit_log
 * (action coupon.update, before/after = snapshots do dominio) na mesma tx. CRUCIAL:
 * CouponInput NAO tem campo redeemedCount e toCouponData nao o emite — logo o UPDATE
 * NUNCA toca redeemed_count (a unica via de mutacao de redeemed_count e a redencao
 * atomica em redeemCoupon). NAO chamamos updateCouponAction porque ela comeca com
 * requireAdmin() (contexto de request: next/headers, Clerk), que quebra fora do HTTP;
 * a action so DELEGA para updateCoupon. O seam `updateCoupon`
 * (tests/harness/estoque/_run-seam.ts) foi ADICIONADO nesta sessao (INFRA de teste —
 * nenhum codigo de produto tocado; o `createCoupon` ja existia).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a MUTACAO (createCoupon/updateCoupon) roda num processo `tsx` separado
 * (_run-seam.ts), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * ANTI-TRIVIALIDADE: ANTES do update forcamos redeemed_count = R > 0 (=7) DIRETO no DB.
 * Se o update tocasse redeemedCount (zerando-o pelo @default ou regravando), o assert
 * "redeemed_count permanece R" pegaria a regressao — com R=0 o teste seria trivial. Os
 * campos editaveis sao alterados para valores NOVOS e distintos dos iniciais, e o assert
 * compara o estado pos-update com os valores NOVOS (nao com os iniciais).
 *
 * Asserts do ledger (3/3 provados via pg):
 *  A1 "Campos editaveis atualizados; redeemed_count permanece R": min_subtotal_cents e
 *     max_redemptions assumem os valores NOVOS; redeemed_count segue == R (7).
 *  A2 "Coerencia tipo<->campo preservada (CHECK valido)": apos o update o cupom percent
 *     mantem percent_off NOT NULL em 1..100 e value_cents NULL; 0 violacoes do predicado
 *     do CHECK coupons_type_value_chk na tabela inteira.
 *  A3 "audit_log recebe 1 linha coupon.update na MESMA transacao, before/after": delta
 *     GLOBAL de audit_log == +1; exatamente 1 linha coupon.update para esse entity_id;
 *     before/after snapshots batem com os valores antigos/novos.
 *
 * Invariantes cobertas: coupon-coherence (A2), coupon-redeem-limits (A1: update nao mexe
 * em redeemedCount, dominio dos contadores intacto), audit-same-tx (A3), cents-only
 * (todos os *Cents persistem como Int sem fracao).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type CouponMutationResult =
  | { ok: false; error: string }
  | {
      ok: true;
      coupon: {
        id: string;
        code: string;
        type: string;
        percentOff: number | null;
        valueCents: number | null;
        minSubtotalCents: number;
        maxRedemptions: number | null;
        perUserLimit: number | null;
        redeemedCount: number;
      };
    };

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

const ACTOR = { clerkUserId: null, email: null, role: null };

/** Input de cupom percent valido, parametrizado pelos campos editaveis sob teste. */
function couponInput(args: {
  code: string;
  percentOff: number;
  minSubtotalCents: number;
  maxRedemptions: number | null;
}) {
  return {
    code: args.code,
    type: "percent" as const,
    percentOff: args.percentOff,
    valueCents: null,
    minSubtotalCents: args.minSubtotalCents,
    maxRedemptions: args.maxRedemptions,
    perUserLimit: null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  };
}

/** Predicado IDENTICO ao CHECK coupons_type_value_chk (test-schema-supplement.sql L38-41). */
const VIOLATION_SQL = `
  SELECT COUNT(*)::text AS count FROM "coupons"
  WHERE NOT (
    ("type" = 'percent' AND "percent_off" IS NOT NULL AND "percent_off" BETWEEN 1 AND 100)
    OR ("type" = 'fixed' AND "value_cents" IS NOT NULL AND "value_cents" > 0)
  )
`;

test("cupom.update.audited: edita campos sem tocar redeemed_count, mantem coerencia e audita 1 linha na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- sanity: o CHECK coupons_type_value_chk existe (senao a coerencia seria vacua).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'coupons_type_value_chk'`,
    );
    expect(chk.rowCount, "CHECK coupons_type_value_chk deve existir").toBe(1);

    // --- passo 0: cria o cupom existente via PRODUCAO (createCoupon). Valores INICIAIS.
    const slug = randomUUID().slice(0, 8);
    const code = `UPD-${slug}`;
    const INITIAL_MIN = 5000;
    const INITIAL_MAX = 10;
    const INITIAL_PERCENT = 15;

    const created = runSeam<CouponMutationResult>("createCoupon", {
      actor: ACTOR,
      input: couponInput({
        code,
        percentOff: INITIAL_PERCENT,
        minSubtotalCents: INITIAL_MIN,
        maxRedemptions: INITIAL_MAX,
      }),
    });
    expect(created.ok, `criacao inicial deveria ter sucesso: ${JSON.stringify(created)}`).toBe(
      true,
    );
    if (!created.ok) throw new Error("inalcancavel");
    const couponId = created.coupon.id;
    expect(couponId).toBeTruthy();

    // --- passo 1: forca redeemed_count = R > 0 DIRETO no DB (anti-trivial). A unica via
    //     de mutacao em producao e redeemCoupon (redencao atomica); aqui semeamos o
    //     contador p/ provar que o update NAO o altera, sem depender da redencao.
    const R = 7;
    await client.query(`UPDATE "coupons" SET redeemed_count = $1 WHERE id = $2`, [R, couponId]);

    // Snapshot do estado pre-update (audit baseline + valores antigos p/ before/after).
    const auditBaseline = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const A = Number(auditBaseline.rows[0].count);

    const preRow = await client.query<{
      min_subtotal_cents: number;
      max_redemptions: number;
      percent_off: number;
      value_cents: number | null;
      redeemed_count: number;
    }>(
      `SELECT min_subtotal_cents, max_redemptions, percent_off, value_cents, redeemed_count
         FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(preRow.rowCount).toBe(1);
    expect(preRow.rows[0].min_subtotal_cents).toBe(INITIAL_MIN);
    expect(preRow.rows[0].max_redemptions).toBe(INITIAL_MAX);
    expect(preRow.rows[0].redeemed_count, "seed de R aplicado").toBe(R);

    // --- passo 2: updateCoupon de PRODUCAO alterando min_subtotal_cents e
    //     max_redemptions p/ valores NOVOS e distintos dos iniciais. percentOff segue
    //     coerente (percent). NAO ha campo redeemedCount em CouponInput.
    const NEW_MIN = 8000;
    const NEW_MAX = 25;
    expect(NEW_MIN).not.toBe(INITIAL_MIN);
    expect(NEW_MAX).not.toBe(INITIAL_MAX);

    const updated = runSeam<CouponMutationResult>("updateCoupon", {
      actor: ACTOR,
      id: couponId,
      input: couponInput({
        code,
        percentOff: INITIAL_PERCENT,
        minSubtotalCents: NEW_MIN,
        maxRedemptions: NEW_MAX,
      }),
    });
    expect(updated.ok, `update deveria ter sucesso: ${JSON.stringify(updated)}`).toBe(true);
    if (!updated.ok) throw new Error("inalcancavel");
    // O dominio retornado ja deve refletir os novos editaveis e R preservado.
    expect(updated.coupon.minSubtotalCents).toBe(NEW_MIN);
    expect(updated.coupon.maxRedemptions).toBe(NEW_MAX);
    expect(updated.coupon.redeemedCount, "retorno do dominio preserva R").toBe(R);

    // === A1: campos editaveis atualizados; redeemed_count permanece R (via pg). =====
    const postRow = await client.query<{
      min_subtotal_cents: number;
      max_redemptions: number;
      percent_off: number;
      value_cents: number | null;
      redeemed_count: number;
    }>(
      `SELECT min_subtotal_cents, max_redemptions, percent_off, value_cents, redeemed_count
         FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(postRow.rowCount).toBe(1);
    expect(postRow.rows[0].min_subtotal_cents, "min_subtotal_cents atualizado").toBe(NEW_MIN);
    expect(postRow.rows[0].max_redemptions, "max_redemptions atualizado").toBe(NEW_MAX);
    expect(
      postRow.rows[0].redeemed_count,
      "redeemed_count permanece R (update NUNCA toca redeemedCount)",
    ).toBe(R);

    // cents-only: os *Cents persistem como Int sem fracao (typeof number, == Math.trunc).
    expect(Number.isInteger(postRow.rows[0].min_subtotal_cents)).toBe(true);
    expect(Number.isInteger(postRow.rows[0].redeemed_count)).toBe(true);

    // === A2: coerencia tipo<->campo preservada (CHECK valido). ======================
    expect(postRow.rows[0].percent_off, "percent: percent_off NOT NULL").not.toBeNull();
    expect(postRow.rows[0].percent_off, "percent_off em 1..100").toBeGreaterThanOrEqual(1);
    expect(postRow.rows[0].percent_off).toBeLessThanOrEqual(100);
    expect(postRow.rows[0].value_cents, "percent: value_cents NULL").toBeNull();
    const viol = await client.query<{ count: string }>(VIOLATION_SQL);
    expect(
      Number(viol.rows[0].count),
      "0 linhas violam o predicado do CHECK coupons_type_value_chk apos o update",
    ).toBe(0);

    // === A3: audit_log recebe 1 linha coupon.update na MESMA tx, before/after. =======
    // (1) delta GLOBAL == +1 (a unica escrita de audit veio do update bem-sucedido).
    const auditAfter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfter.rows[0].count),
      "update audita exatamente 1 linha (delta global +1)",
    ).toBe(A + 1);

    // (2) exatamente 1 linha coupon.update para esse entity_id (action e o @map DOTTED,
    //     lido da coluna crua). before/after snapshots corretos.
    const auditRows = await client.query<{
      action: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>(
      `SELECT action, before, after FROM "audit_log"
         WHERE action = 'coupon.update' AND entity_id = $1`,
      [couponId],
    );
    expect(auditRows.rowCount, "exatamente 1 audit coupon.update para esse cupom").toBe(1);
    const { before, after } = auditRows.rows[0];
    expect(before, "before snapshot presente").not.toBeNull();
    expect(after, "after snapshot presente").not.toBeNull();
    // before = valores ANTIGOS; after = valores NOVOS (snapshot do dominio).
    expect(before?.minSubtotalCents, "before.minSubtotalCents = valor antigo").toBe(INITIAL_MIN);
    expect(before?.maxRedemptions, "before.maxRedemptions = valor antigo").toBe(INITIAL_MAX);
    expect(after?.minSubtotalCents, "after.minSubtotalCents = valor novo").toBe(NEW_MIN);
    expect(after?.maxRedemptions, "after.maxRedemptions = valor novo").toBe(NEW_MAX);
    // coerencia tipo<->campo tambem no snapshot (percent: percentOff set, valueCents null).
    expect(after?.type).toBe("percent");
    expect(after?.percentOff).toBe(INITIAL_PERCENT);
    expect(after?.valueCents).toBeNull();
  } finally {
    await client.end();
  }
});

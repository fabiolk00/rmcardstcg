import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.delete.unused-ok (priority 26) — DB-first, sem browser.
 *
 * Prova "Admin exclui cupom SEM redencao (hard-delete auditado)" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * cupom-create-percent.spec.ts / cupom-deactivate-audited.spec.ts: roda em Node (sem
 * `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: deleteCoupon(actor, id) de lib/data/coupons.ts (L257) — a funcao de
 * PRODUCAO de MENOR NIVEL que prova as invariantes. Numa MESMA prisma.$transaction ela:
 *   (1) le o cupom (before); se inexistente -> 'not_found';
 *   (2) conta coupon_redemptions WHERE coupon_id=id; se > 0 -> 'in_use' SEM apagar
 *       (coupon-delete-guard: historico financeiro protegido pela FK onDelete:Restrict);
 *   (3) senao faz tx.coupon.delete (hard-delete, o 'D' do CRUD) e grava audit_log
 *       (action coupon.delete, before=snapshot, after=null) na MESMA tx.
 * NAO chamamos deleteCouponAction porque ela comeca com requireAdmin() (contexto de
 * request: next/headers, Clerk), que quebra fora do HTTP; a action so DELEGA para
 * deleteCoupon. O seam `deleteCoupon` (tests/harness/estoque/_run-seam.ts) foi ADICIONADO
 * nesta sessao (INFRA de teste — nenhum codigo de produto tocado).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a MUTACAO (createCoupon/deleteCoupon) roda num processo `tsx` separado
 * (_run-seam.ts), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * ANTI-TRIVIALIDADE:
 *  - ANTES de excluir, semeamos o cupom de fato (createCoupon o cria), ASSERTAMOS que ele
 *    EXISTE no DB (COUNT==1) E que NAO ha nenhuma linha em coupon_redemptions para ele.
 *    Sem essa pre-condicao "some apos delete" seria vacuo (nada a apagar) e o ramo testado
 *    poderia ser o 'in_use' por engano.
 *  - Forcamos redeemed_count = R > 0 (=3) DIRETO no DB (sem inserir coupon_redemptions): o
 *    contador NAO e o que a guarda olha (a guarda conta coupon_redemptions), entao o delete
 *    AINDA deve passar mesmo com redeemed_count>0. Isso prova que a guarda olha o HISTORICO
 *    (coupon_redemptions), nao o contador denormalizado — diferenciando de cupom.delete.used.
 *  - Medimos o delta de audit_log GLOBAL (+1 exato): prova que excluir audita UMA linha
 *    (nem 0, nem 2) na mesma tx, nao so a presenca de linha.
 *  - O entity_id e UNICO por run (cupom recem-criado): a contagem por action+entity isola a
 *    linha desta feature de qualquer ruido do seed.
 *  - SANITY de schema: assertamos a existencia da FK coupon_redemptions.coupon_id com
 *    confdeltype 'r' (RESTRICT) — senao a guarda de delete e a propria invariante seriam
 *    vacuas (um delete cego nao precisaria de guarda).
 *
 * Asserts do ledger (2/2 provados via pg):
 *  A1 "Resultado ok:true; a linha some de coupons (hard-delete, o 'D' do CRUD)": retorno
 *     { ok:true, id }; COUNT(*) em coupons para o id passa de 1 -> 0 (linha realmente some,
 *     nao e soft-delete). is_active anterior nem importa — a linha deixa de existir.
 *  A2 "audit_log recebe 1 linha action=coupon.delete na MESMA tx, before=snapshot, after=
 *     null": delta GLOBAL == +1; exatamente 1 linha 'coupon.delete' (action = @map DOTTED,
 *     lida da coluna crua) para esse entity_id; before e o snapshot do dominio (code/type/...
 *     batendo com o cupom criado), after IS NULL (linha apagada).
 *
 * Invariantes cobertas:
 *  - coupon-delete-guard: o delete SO procede porque NAO ha redencao (guarda olha
 *    coupon_redemptions, nao redeemed_count). A FK onDelete:Restrict (sanity de schema)
 *    e o que tornaria o delete impossivel se houvesse historico — aqui nao ha, entao
 *    procede e a linha some.
 *  - audit-same-tx: exatamente 1 linha de audit_log gravada na MESMA transacao do delete
 *    (writeAuditLog recebe o `tx` dentro do prisma.$transaction de deleteCoupon), com
 *    action/before/after corretos. Como o delete e atomico com o audit, ou as duas coisas
 *    acontecem (linha some E audit existe) ou nenhuma — sem orfao.
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
        isActive: boolean;
        redeemedCount: number;
      };
    };

type CouponDeleteResult = { ok: true; id: string } | { ok: false; error: string };

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

/** Input de cupom percent valido (semeado via createCoupon de PRODUCAO). */
function percentCoupon(code: string) {
  return {
    code,
    type: "percent" as const,
    percentOff: 15,
    valueCents: null,
    minSubtotalCents: 5000,
    maxRedemptions: null,
    perUserLimit: null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  };
}

type AuditRow = {
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

test("cupom.delete.unused-ok: cupom sem redencao some (hard-delete) e audita coupon.delete (before=snapshot, after=null) na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- SANITY de schema: a FK coupon_redemptions.coupon_id e onDelete:Restrict.
    // Sem isso a guarda de delete (e a invariante coupon-delete-guard) seriam vacuas.
    const fk = await client.query<{ confdeltype: string }>(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname = 'coupon_redemptions'
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.conrelid
               AND a.attnum = ANY (c.conkey)
               AND a.attname = 'coupon_id'
          )`,
    );
    expect(fk.rowCount, "FK em coupon_redemptions.coupon_id deve existir").toBeGreaterThanOrEqual(
      1,
    );
    expect(
      fk.rows.some((r) => r.confdeltype === "r"),
      "FK coupon_redemptions.coupon_id deve ser onDelete RESTRICT ('r')",
    ).toBe(true);

    // --- passo 0: cria o cupom via PRODUCAO (createCoupon).
    const slug = randomUUID().slice(0, 8);
    const code = `DELOK-${slug}`;
    const created = runSeam<CouponMutationResult>("createCoupon", {
      actor: ACTOR,
      input: percentCoupon(code),
    });
    expect(created.ok, `criacao inicial deveria ter sucesso: ${JSON.stringify(created)}`).toBe(
      true,
    );
    if (!created.ok) throw new Error("inalcancavel");
    const couponId = created.coupon.id;
    expect(couponId).toBeTruthy();

    // pre-condicao anti-trivial #1: o cupom EXISTE de fato no DB.
    const pre = await client.query<{ code: string; type: string }>(
      `SELECT code, type FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(pre.rowCount, "cupom semeado deve existir antes do delete (senao seria vacuo)").toBe(1);
    expect(pre.rows[0].code, "code armazenado em UPPER (normalizeCouponCode)").toBe(
      code.toUpperCase(),
    );

    // pre-condicao anti-trivial #2: NAO ha redencao para este cupom (o ramo unused-ok).
    const noRedemptions = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions" WHERE coupon_id = $1`,
      [couponId],
    );
    expect(
      Number(noRedemptions.rows[0].count),
      "cupom NAO pode ter redencao (esta feature e o caminho SEM uso)",
    ).toBe(0);

    // anti-trivial #3: forca redeemed_count = R > 0 SEM inserir coupon_redemptions. A guarda
    // do deleteCoupon conta coupon_redemptions (historico real), NAO o contador denormalizado;
    // entao o delete AINDA deve passar. Prova que e o historico que protege, nao o contador.
    const R = 3;
    await client.query(`UPDATE "coupons" SET redeemed_count = $1 WHERE id = $2`, [R, couponId]);

    // baseline de audit GLOBAL antes do delete.
    const baseAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const A0 = Number(baseAudit.rows[0].count);

    // ============================================================================
    // ACAO — EXCLUIR: deleteCoupon(actor, id) de PRODUCAO.
    // ============================================================================
    const del = runSeam<CouponDeleteResult>("deleteCoupon", { actor: ACTOR, id: couponId });

    // === A1: ok:true; a linha some de coupons (hard-delete). ==========================
    expect(del.ok, `exclusao de cupom sem uso deveria ter sucesso: ${JSON.stringify(del)}`).toBe(
      true,
    );
    if (!del.ok) throw new Error("inalcancavel");
    expect(del.id, "retorno carrega o id do cupom excluido").toBe(couponId);

    const afterDel = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(
      Number(afterDel.rows[0].count),
      "a linha do cupom SOME de coupons (hard-delete, nao soft)",
    ).toBe(0);

    // === A2: audit_log recebe 1 linha coupon.delete na MESMA tx, before=snapshot, after=null.
    // (1) delta GLOBAL == +1 (a unica escrita de audit veio do delete).
    const auditAfter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfter.rows[0].count),
      "excluir audita exatamente 1 linha (delta global +1)",
    ).toBe(A0 + 1);

    // (2) exatamente 1 linha coupon.delete p/ esse entity_id (action = @map DOTTED, lida da
    //     coluna crua); before = snapshot do dominio, after IS NULL (linha apagada).
    const delRows = await client.query<AuditRow>(
      `SELECT action, before, after FROM "audit_log"
         WHERE action = 'coupon.delete' AND entity_id = $1`,
      [couponId],
    );
    expect(delRows.rowCount, "exatamente 1 audit coupon.delete para esse cupom").toBe(1);
    const row = delRows.rows[0];
    expect(row.before, "before = snapshot do dominio (nao null)").not.toBeNull();
    expect(row.before?.code, "before.code = code normalizado do cupom").toBe(code.toUpperCase());
    expect(row.before?.type, "before.type = percent").toBe("percent");
    expect(row.before?.percentOff, "before.percentOff = 15").toBe(15);
    expect(row.before?.valueCents, "before.valueCents = null (cupom percent)").toBeNull();
    expect(row.before?.minSubtotalCents, "before.minSubtotalCents = 5000").toBe(5000);
    expect(row.before?.isActive, "before.isActive = true (cupom estava ativo)").toBe(true);
    // o snapshot NAO carrega redeemedCount (couponSnapshot so guarda os campos do dominio
    // editaveis) — entao nao asserimos R aqui; o ponto e que a guarda nao olhou o contador.
    expect(row.after, "after IS NULL (cupom deixou de existir)").toBeNull();

    // anti-confusao: o delete NAO gravou coupon.deactivate (nao foi soft-delete disfarcado).
    const noDeactivate = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE action = 'coupon.deactivate' AND entity_id = $1`,
      [couponId],
    );
    expect(
      Number(noDeactivate.rows[0].count),
      "excluir NAO audita coupon.deactivate (hard-delete, nao inativacao)",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

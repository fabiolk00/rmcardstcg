import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.deactivate.audited (priority 25) — DB-first, sem browser.
 *
 * Prova "Admin inativa cupom (coupon.deactivate auditado)" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * cupom-create-percent.spec.ts / cupom-update-audited.spec.ts: roda em Node (sem
 * `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: setCouponActive(actor, id, isActive) de lib/data/coupons.ts (L213)
 * — a funcao de PRODUCAO de MENOR NIVEL que prova as invariantes. Numa MESMA
 * prisma.$transaction ela le o cupom (before), faz tx.coupon.update apenas do campo
 * isActive e grava audit_log na mesma tx, com action DEPENDENTE do destino:
 *   isActive=false -> AuditAction.coupon_deactivate (@map 'coupon.deactivate')
 *   isActive=true  -> AuditAction.coupon_update      (@map 'coupon.update')
 * NAO chamamos setCouponActiveAction porque ela comeca com requireAdmin() (contexto de
 * request: next/headers, Clerk), que quebra fora do HTTP; a action so DELEGA para
 * setCouponActive. O seam `setCouponActive` (tests/harness/estoque/_run-seam.ts) foi
 * ADICIONADO nesta sessao (INFRA de teste — nenhum codigo de produto tocado; os seams
 * createCoupon/updateCoupon ja existiam).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a MUTACAO (createCoupon/setCouponActive) roda num processo `tsx` separado
 * (_run-seam.ts), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * ANTI-TRIVIALIDADE:
 *  - ANTES de inativar, semeamos o cupom como is_active=TRUE de fato (createCoupon o cria
 *    ativo) e ASSERTAMOS isso no DB; sem essa pre-condicao o assert "vira false" seria
 *    vacuo (se ja fosse false, nada provaria).
 *  - Forcamos redeemed_count = R > 0 (=4) DIRETO no DB: setCouponActive so deve mexer em
 *    is_active. Se a funcao regravasse o cupom inteiro (zerando o contador pelo @default),
 *    o assert "redeemed_count preservado" pegaria a regressao — com R=0 seria trivial.
 *  - Medimos o delta de audit_log GLOBAL em cada passo (+1 exato), nao so a presenca de
 *    linha: prova que a operacao audita UMA linha (nem 0, nem 2) na mesma tx.
 *  - O entity_id e UNICO por run (cupom recem-criado), entao a contagem por action+entity
 *    isola a linha desta feature de qualquer ruido do seed.
 *
 * Asserts do ledger (3/3 provados via pg):
 *  A1 "coupons.is_active == false (cupom sai de circulacao sem ser apagado)": apos o
 *     desligamento o is_active e false E a linha continua existindo (COUNT==1, sem delete).
 *  A2 "audit_log recebe 1 linha action=coupon.deactivate (ao desligar) na MESMA tx":
 *     delta GLOBAL de audit_log == +1; exatamente 1 linha 'coupon.deactivate' para esse
 *     entity_id; before.isActive=true, after.isActive=false (snapshots do dominio).
 *  A3 "Religar (setCouponActive true) audita como coupon.update": apos religar o is_active
 *     volta a true; delta GLOBAL == +1; a linha de auditoria do religamento tem action
 *     'coupon.update' (NAO 'coupon.deactivate'); before.isActive=false, after.isActive=true.
 *
 * Invariante coberta (unica listada): audit-same-tx — em cada mutacao bem-sucedida
 * exatamente 1 linha de audit_log e gravada na MESMA transacao do UPDATE (writeAuditLog
 * recebe o `tx` dentro do prisma.$transaction de setCouponActive), com action/before/after
 * corretos. Nenhuma outra invariante esta listada e setCouponActive nao toca preco/estoque,
 * entao correto nao asserir cents-only/reserved etc. alem da preservacao incidental abaixo.
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
        isActive: boolean;
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

/** Input de cupom percent valido e ativo (semeado via createCoupon de PRODUCAO). */
function activePercentCoupon(code: string) {
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

type AuditRow = {
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

test("cupom.deactivate.audited: inativar audita coupon.deactivate (mesma tx); religar audita coupon.update", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- passo 0: cria o cupom ATIVO via PRODUCAO (createCoupon).
    const slug = randomUUID().slice(0, 8);
    const code = `DEAC-${slug}`;
    const created = runSeam<CouponMutationResult>("createCoupon", {
      actor: ACTOR,
      input: activePercentCoupon(code),
    });
    expect(created.ok, `criacao inicial deveria ter sucesso: ${JSON.stringify(created)}`).toBe(
      true,
    );
    if (!created.ok) throw new Error("inalcancavel");
    const couponId = created.coupon.id;
    expect(couponId).toBeTruthy();

    // pre-condicao anti-trivial #1: o cupom esta ATIVO de fato no DB.
    const pre = await client.query<{ is_active: boolean }>(
      `SELECT is_active FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(pre.rowCount, "cupom semeado deve existir").toBe(1);
    expect(pre.rows[0].is_active, "cupom comeca ATIVO (senao inativar seria vacuo)").toBe(true);

    // anti-trivial #2: forca redeemed_count = R > 0 DIRETO no DB. setCouponActive so deve
    // mexer em is_active; se regravasse o cupom inteiro, o contador (R) seria perdido.
    const R = 4;
    await client.query(`UPDATE "coupons" SET redeemed_count = $1 WHERE id = $2`, [R, couponId]);

    // baseline de audit GLOBAL antes do desligamento.
    const baseDeact = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const A0 = Number(baseDeact.rows[0].count);

    // ============================================================================
    // PASSO 1 — INATIVAR: setCouponActive(actor, id, false) de PRODUCAO.
    // ============================================================================
    const off = runSeam<CouponMutationResult>("setCouponActive", {
      actor: ACTOR,
      id: couponId,
      isActive: false,
    });
    expect(off.ok, `inativacao deveria ter sucesso: ${JSON.stringify(off)}`).toBe(true);
    if (!off.ok) throw new Error("inalcancavel");
    expect(off.coupon.isActive, "dominio retornado: is_active false").toBe(false);
    // retorno do dominio preserva o contador (so is_active mudou).
    expect(off.coupon.redeemedCount, "retorno do dominio preserva R").toBe(R);

    // === A1: coupons.is_active == false; linha NAO removida (soft, nao delete). =======
    const afterOff = await client.query<{ is_active: boolean; redeemed_count: number }>(
      `SELECT is_active, redeemed_count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(afterOff.rowCount, "cupom continua existindo (inativacao != delete)").toBe(1);
    expect(afterOff.rows[0].is_active, "is_active == false apos inativar").toBe(false);
    // setCouponActive so toca is_active: redeemed_count intocado.
    expect(
      afterOff.rows[0].redeemed_count,
      "redeemed_count preservado (setCouponActive so muda is_active)",
    ).toBe(R);
    expect(Number.isInteger(afterOff.rows[0].redeemed_count)).toBe(true);

    // === A2: audit_log recebe 1 linha coupon.deactivate na MESMA tx, before/after. ====
    // (1) delta GLOBAL == +1 (a unica escrita de audit veio do desligamento).
    const auditAfterOff = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfterOff.rows[0].count),
      "inativar audita exatamente 1 linha (delta global +1)",
    ).toBe(A0 + 1);

    // (2) exatamente 1 linha coupon.deactivate p/ esse entity_id (action = @map DOTTED,
    //     lido da coluna crua). before.isActive=true, after.isActive=false.
    const deactRows = await client.query<AuditRow>(
      `SELECT action, before, after FROM "audit_log"
         WHERE action = 'coupon.deactivate' AND entity_id = $1`,
      [couponId],
    );
    expect(deactRows.rowCount, "exatamente 1 audit coupon.deactivate para esse cupom").toBe(1);
    expect(deactRows.rows[0].before?.isActive, "before.isActive = true").toBe(true);
    expect(deactRows.rows[0].after?.isActive, "after.isActive = false").toBe(false);
    // anti-confusao: o desligamento NAO gravou um coupon.update.
    const noUpdateYet = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE action = 'coupon.update' AND entity_id = $1`,
      [couponId],
    );
    expect(
      Number(noUpdateYet.rows[0].count),
      "desligar NAO audita coupon.update (action depende do destino)",
    ).toBe(0);

    // ============================================================================
    // PASSO 2 — RELIGAR: setCouponActive(actor, id, true) audita coupon.update.
    // ============================================================================
    const baseReact = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const A1 = Number(baseReact.rows[0].count);

    const on = runSeam<CouponMutationResult>("setCouponActive", {
      actor: ACTOR,
      id: couponId,
      isActive: true,
    });
    expect(on.ok, `religamento deveria ter sucesso: ${JSON.stringify(on)}`).toBe(true);
    if (!on.ok) throw new Error("inalcancavel");
    expect(on.coupon.isActive, "dominio retornado: is_active true").toBe(true);

    // === A3: is_active volta a true; religar audita coupon.update (NAO deactivate). ===
    const afterOn = await client.query<{ is_active: boolean }>(
      `SELECT is_active FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(afterOn.rows[0].is_active, "is_active == true apos religar").toBe(true);

    // delta GLOBAL == +1 (religar audita exatamente 1 linha).
    const auditAfterOn = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfterOn.rows[0].count),
      "religar audita exatamente 1 linha (delta global +1)",
    ).toBe(A1 + 1);

    // a NOVA linha (religamento) tem action coupon.update, NAO coupon.deactivate.
    const updateRows = await client.query<AuditRow>(
      `SELECT action, before, after FROM "audit_log"
         WHERE action = 'coupon.update' AND entity_id = $1`,
      [couponId],
    );
    expect(
      updateRows.rowCount,
      "exatamente 1 audit coupon.update para esse cupom (o religamento)",
    ).toBe(1);
    expect(updateRows.rows[0].before?.isActive, "before.isActive = false (estava inativo)").toBe(
      false,
    );
    expect(updateRows.rows[0].after?.isActive, "after.isActive = true (religado)").toBe(true);

    // o desligamento permanece como a UNICA linha coupon.deactivate (religar nao duplicou).
    const deactStill = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE action = 'coupon.deactivate' AND entity_id = $1`,
      [couponId],
    );
    expect(Number(deactStill.rows[0].count), "religar NAO grava outra coupon.deactivate").toBe(1);
  } finally {
    await client.end();
  }
});

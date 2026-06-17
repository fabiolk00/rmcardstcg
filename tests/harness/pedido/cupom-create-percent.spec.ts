import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.create.percent (priority 17) — DB-first, sem browser.
 *
 * Prova "admin cria cupom percentual (usa percentOff, coerencia)" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas (pedido/* e
 * estoque/product-create.spec.ts): roda em Node (sem `page`) e assertaa o estado real
 * via `pg`.
 *
 * SEAM escolhida: createCoupon(actor, input) de lib/data/coupons.ts (L150) — a funcao
 * de MENOR NIVEL que prova as invariantes. Numa MESMA prisma.$transaction ela:
 * normaliza o CouponInput via toCouponData (coerencia tipo<->campo: type='percent'
 * mantem percentOff e ZERA valueCents; codigo em UPPER), faz tx.coupon.create e grava
 * audit_log (action coupon.create, before=null, after=snapshot do cupom) — TUDO na
 * mesma tx. NAO chamamos a server action createCouponAction porque ela comeca com
 * requireAdmin() (contexto de request: next/headers, Clerk), que quebra fora do HTTP;
 * a action so DELEGA para createCoupon.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso a MUTACAO (createCoupon) roda num processo `tsx` separado
 * (tests/harness/estoque/_run-seam.ts, ESTENDIDO nesta sessao com o case `createCoupon`
 * — INFRA de teste, nao codigo de produto), herdando DATABASE_URL; o spec faz TODAS as
 * assercoes via `pg`.
 *
 * ANTI-TRIVIALIDADE / coerencia (coupon-coherence): o input enviado de PROPOSITO
 * carrega valueCents != null (1234) JUNTO de type='percent'. A funcao de PRODUCAO
 * (toCouponData) DEVE zerar esse campo do tipo oposto — entao o assert "value_cents IS
 * NULL" pega qualquer regressao que persistisse o lixo do tipo errado. percentOff usa
 * 10 (faixa 1..100, longe das bordas) p/ casar o CHECK coupons_type_value_chk.
 *
 * Invariantes cobertas:
 *  - coupon-coherence: percent => percent_off preenchido e value_cents NULL; o CHECK
 *    coupons_type_value_chk existe e nenhuma linha o viola.
 *  - audit-same-tx: exatamente 1 linha coupon.create (action DOTTED) na MESMA tx,
 *    before=null, after=snapshot coerente; delta +1 total E +1 por entity_id (rollback
 *    nao deixaria orfao — aqui provado pelo casamento dos dois deltas).
 *  - cents-only: percent_off, value_cents (quando aplicavel) e min_subtotal_cents sao
 *    Int (sem float); redeemed_count Int=0.
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type CouponSnapshot = {
  code: string;
  type: string;
  percentOff: number | null;
  valueCents: number | null;
  minSubtotalCents: number;
  isActive: boolean;
};
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

test("cupom.create.percent: cria cupom percentual, zera value_cents (coerencia) e audita na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- passo 1: contagens iniciais (coupons N e audit_log A).
    const before = await client.query<{ coupons: string; audit: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "coupons")::text   AS coupons,
         (SELECT COUNT(*) FROM "audit_log")::text AS audit`,
    );
    const N = Number(before.rows[0].coupons);
    const A = Number(before.rows[0].audit);

    // --- passo 2: createCoupon com type='percent', percentOff=10. DE PROPOSITO o
    //     input carrega valueCents != null (lixo do tipo oposto) p/ provar que
    //     toCouponData (PRODUCAO) o ZERA. minSubtotalCents Int de centavos (R$ 50,00).
    //     code minusculo p/ provar a normalizacao UPPER. id unico por run.
    const rawCode = `harness-pct-${randomUUID().slice(0, 8)}`;
    const expectedCode = rawCode.toUpperCase();
    const input = {
      code: rawCode,
      type: "percent" as const,
      percentOff: 10,
      valueCents: 1234, // ANTI-TRIVIAL: lixo do tipo 'fixed'; PRODUCAO deve zerar.
      minSubtotalCents: 5000, // Int de centavos (R$ 50,00)
      maxRedemptions: null,
      perUserLimit: null,
      isActive: true,
      startsAt: null,
      expiresAt: null,
    };
    // Ator anonimo de dev (mock-first: sem Clerk os tres campos sao null — ver
    // getAuditActor em lib/data/audit.ts). A auditoria grava mesmo assim.
    const actor = { clerkUserId: null, email: null, role: null };

    const res = runSeam<CreateCouponResult>("createCoupon", { actor, input });
    expect(res.ok, `createCoupon deveria ter sucesso: ${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) throw new Error("inalcancavel");
    const couponId = res.coupon.id;
    expect(couponId, "createCoupon deve retornar o cupom criado").toBeTruthy();
    expect(res.coupon.type).toBe("percent");

    // --- assert: coupons ganha EXATAMENTE 1 linha (count == N+1).
    const afterCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupons"`,
    );
    expect(Number(afterCount.rows[0].count), "coupons deve ganhar 1 linha").toBe(N + 1);

    // --- assert: a linha persistida tem type='percent', percent_off=10, value_cents
    //     NULL (coerencia: toCouponData zerou o campo do outro tipo), redeemed_count=0,
    //     is_active=true, code normalizado em UPPER, min_subtotal_cents Int exato.
    const row = await client.query<{
      code: string;
      type: string;
      percent_off: number | null;
      value_cents: number | null;
      min_subtotal_cents: number;
      redeemed_count: number;
      is_active: boolean;
    }>(
      `SELECT code, type, percent_off, value_cents, min_subtotal_cents, redeemed_count, is_active
         FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(row.rowCount).toBe(1);
    const c = row.rows[0];

    expect(c.type, "type persistido = percent").toBe("percent");
    expect(c.percent_off, "percent_off = 10").toBe(10);
    // COERENCIA (anti-trivial): apesar de valueCents=1234 no input, PRODUCAO zera o
    // campo do tipo oposto -> value_cents IS NULL na linha real.
    expect(c.value_cents, "percent => value_cents zerado (NULL) pela coerencia").toBeNull();
    expect(c.redeemed_count, "cupom novo nasce com redeemed_count=0").toBe(0);
    expect(c.is_active, "cupom novo nasce ativo").toBe(true);
    // code normalizado em UPPER (normalizeCouponCode): minusculas do input desaparecem.
    expect(c.code, "code armazenado normalizado em UPPER").toBe(expectedCode);

    // cents-only: Int sem float em percent_off / min_subtotal_cents / redeemed_count.
    expect(c.percent_off).not.toBeNull();
    expect(Number.isInteger(c.percent_off as number)).toBe(true);
    expect(c.min_subtotal_cents).toBe(5000);
    expect(Number.isInteger(c.min_subtotal_cents)).toBe(true);
    expect(Number.isInteger(c.redeemed_count)).toBe(true);

    // --- assert: o CHECK coupons_type_value_chk existe e nenhuma linha o viola
    //     (percent: percent_off entre 1 e 100, value_cents NULL). Asserta o predicado
    //     real do constraint contra a tabela inteira.
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'coupons_type_value_chk'`,
    );
    expect(chk.rowCount, "CHECK coupons_type_value_chk deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupons"
         WHERE NOT (
           ("type" = 'percent' AND "percent_off" IS NOT NULL AND "percent_off" BETWEEN 1 AND 100)
           OR ("type" = 'fixed' AND "value_cents" IS NOT NULL AND "value_cents" > 0)
         )`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola a coerencia type<->campo").toBe(
      0,
    );

    // --- assert: audit_log ganha EXATAMENTE 1 linha (count == A+1), action=coupon.create
    //     (valor DOTTED do enum), entity_type=coupon, before=null, after=snapshot
    //     coerente — na MESMA transacao (rollback nao deixaria orfao; aqui provado pelo
    //     casamento do delta total +1 com o delta por entity_id +1).
    const afterAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(Number(afterAudit.rows[0].count), "audit_log deve ganhar 1 linha").toBe(A + 1);

    const audit = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: unknown;
      after: CouponSnapshot;
    }>(
      `SELECT action, entity_type, entity_id, before, after
         FROM "audit_log" WHERE entity_id = $1`,
      [couponId],
    );
    expect(audit.rowCount, "1 linha de audit para este cupom (na mesma tx)").toBe(1);
    const log = audit.rows[0];

    // action gravado com o valor DOTTED do enum (schema.prisma: @map("coupon.create")).
    expect(log.action).toBe("coupon.create");
    expect(log.entity_type).toBe("coupon");
    expect(log.entity_id).toBe(couponId);
    expect(log.before, "create: before deve ser null").toBeNull();

    // after = snapshot do dominio (camelCase) coerente com a linha real.
    expect(log.after, "after deve ser o snapshot do cupom").toBeTruthy();
    expect(log.after.code).toBe(expectedCode);
    expect(log.after.type).toBe("percent");
    expect(log.after.percentOff).toBe(10);
    expect(log.after.valueCents, "snapshot reflete a coerencia: valueCents NULL").toBeNull();
    expect(log.after.minSubtotalCents).toBe(5000);
    expect(log.after.isActive).toBe(true);
  } finally {
    await client.end();
  }
});

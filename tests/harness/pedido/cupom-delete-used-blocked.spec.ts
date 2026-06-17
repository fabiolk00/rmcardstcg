import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.delete.used-blocked (priority 27) — DB-first, sem browser.
 *
 * Prova "Excluir cupom JA USADO e bloqueado (FK Restrict); deve inativar" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * cupom-delete-unused-ok.spec.ts / cupom-redeem-global-limit.spec.ts: roda em Node
 * (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: deleteCoupon(actor, id) de lib/data/coupons.ts (L257) — a funcao de
 * PRODUCAO de MENOR NIVEL que carrega a guarda coupon-delete-guard. Numa MESMA
 * prisma.$transaction ela: (1) le o cupom (before); se inexistente -> 'not_found';
 * (2) CONTA coupon_redemptions WHERE coupon_id=id e, se > 0, retorna 'in_use' SEM
 * apagar e SEM gravar audit (historico financeiro protegido); (3) senao faria o
 * hard-delete + audit coupon.delete. Aqui exercitamos o ramo (2): o cupom TEM uma
 * redencao REAL, entao deleteCoupon deve devolver { ok:false, error: COUPON_IN_USE }.
 * NAO chamamos deleteCouponAction porque ela comeca com requireAdmin() (contexto de
 * request: next/headers, Clerk), que quebra fora do HTTP; a action so DELEGA para
 * deleteCoupon. Os seams `createCoupon`/`redeemCoupon`/`deleteCoupon`
 * (tests/harness/estoque/_run-seam.ts) ja existem — INFRA de teste, nenhum codigo de
 * produto tocado.
 *
 * COMO criamos o "ja usado" SEM falsear: a redencao e gravada pela FUNCAO DE PRODUCAO
 * redeemCoupon(tx, ...) (a mesma do checkout), que insere 1 linha REAL em
 * coupon_redemptions atrelada a um pedido PROPRIO (FK order_id -> orders.id). Nao
 * inserimos a linha de redencao na mao: e o caminho de producao que cria o historico
 * financeiro que a guarda protege. (Diferente da feature unused-ok, que forcava
 * redeemed_count>0 SEM linha de redencao p/ provar que a guarda olha o HISTORICO, nao o
 * contador — aqui provamos o complemento: COM historico, o delete e barrado.)
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a MUTACAO (createCoupon/redeemCoupon/deleteCoupon) roda num processo `tsx`
 * separado (_run-seam.ts), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * ANTI-TRIVIALIDADE:
 *  - ANTES de tentar excluir, ASSERTAMOS que o cupom EXISTE (COUNT==1) E que ha >=1 linha
 *    REAL em coupon_redemptions p/ ele (criada pela redencao de PRODUCAO). Sem essa
 *    pre-condicao o teste cairia no ramo errado (not_found) ou seria vacuo.
 *  - Medimos o delta de audit_log GLOBAL: deve ser 0 (excluir um cupom usado NAO grava
 *    audit). Isolamos tambem por action+entity: 0 linhas coupon.delete p/ esse cupom.
 *  - O entity_id e UNICO por run (cupom recem-criado): a contagem por action+entity isola
 *    o resultado desta feature de qualquer ruido do seed.
 *  - SANITY de schema: assertamos que a FK coupon_redemptions.coupon_id e onDelete
 *    RESTRICT (confdeltype 'r') — e ELA que torna o delete impossivel se houvesse
 *    historico (a guarda da aplicacao + a FK como rede final). Sem RESTRICT a invariante
 *    coupon-delete-guard seria vacua.
 *  - CAMINHO CORRETO: depois do delete barrado, provamos que INATIVAR funciona —
 *    setCouponActive(actor,id,false) deixa is_active=false (cupom sai de circulacao SEM
 *    apagar) e a linha CONTINUA em coupons. Isso fecha o assert "Caminho correto e
 *    inativar, nao excluir".
 *
 * Asserts do ledger (4/4 provados via pg):
 *  A1 "Resultado ok:false com a mensagem 'Cupom ja foi utilizado...' (in_use)": retorno
 *     { ok:false, error } cuja mensagem comeca por "Cupom já foi utilizado".
 *  A2 "A linha PERMANECE em coupons (FK onDelete Restrict protege o historico)":
 *     COUNT(*) em coupons para o id continua 1 apos o delete barrado (nada apagado).
 *  A3 "audit_log NAO ganha linha de coupon.delete": delta GLOBAL de audit_log == 0; e
 *     exatamente 0 linhas action='coupon.delete' (action = @map DOTTED, coluna crua) p/
 *     esse entity_id.
 *  A4 "Caminho correto e inativar (setCouponActive false), nao excluir": setCouponActive
 *     deixa is_active=false e o cupom CONTINUA existindo (COUNT==1).
 *
 * Invariantes cobertas:
 *  - coupon-delete-guard: o delete e RECUSADO porque ha redencao (a guarda conta
 *    coupon_redemptions; a FK onDelete:Restrict — sanity de schema — e a rede final).
 *    O historico financeiro (a linha de coupon_redemptions com discount_cents do pedido)
 *    sobrevive intacto.
 *  - audit-same-tx: como o delete NAO procede, NENHUMA linha de audit_log e gravada
 *    (nem orfa). A transacao do deleteCoupon retorna 'in_use' antes do delete/writeAuditLog.
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
type RedeemResult = { ok: true; alreadyRedeemed: boolean } | { ok: false; reason: string };

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
    minSubtotalCents: 0,
    maxRedemptions: null,
    perUserLimit: null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  };
}

/** Cria um pedido PROPRIO minimo (INSERT direto em pg) e devolve seu id. */
async function insertOrder(client: Client, tag: string): Promise<number> {
  const ins = await client.query<{ id: number }>(
    `INSERT INTO "orders" (
       clerk_user_id, customer_name, customer_email, customer_phone,
       address_cep, address_street, address_city, address_state,
       subtotal_cents, discount_cents, shipping_cents, total_cents,
       payment_status, payment_method, shipping_status,
       stock_reserved, stock_committed
     ) VALUES (
       $1, $2, $3, $4,
       '01001000', 'Rua Teste', 'Sao Paulo', 'SP',
       10000, 0, 0, 10000,
       'pending', 'pix', 'pending',
       false, false
     ) RETURNING id`,
    [`user-${tag}`, "Cliente Harness", `cliente-${tag}@harness.test`, "11999999999"],
  );
  return ins.rows[0].id;
}

test("cupom.delete.used-blocked: cupom COM redencao real nao e excluido (in_use), linha persiste, sem audit coupon.delete; inativar e o caminho", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- SANITY de schema: a FK coupon_redemptions.coupon_id e onDelete:Restrict.
    // E ela (mais a guarda da aplicacao) que protege o historico; sem RESTRICT a
    // invariante coupon-delete-guard seria vacua.
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
    const code = `DELUSED-${slug}`;
    const userId = `user-${slug}`;
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

    // pre-condicao: o cupom EXISTE de fato no DB.
    const pre = await client.query<{ code: string }>(`SELECT code FROM "coupons" WHERE id = $1`, [
      couponId,
    ]);
    expect(pre.rowCount, "cupom semeado deve existir antes do delete").toBe(1);

    // --- passo 1: REDIME o cupom para um pedido PROPRIO via PRODUCAO (redeemCoupon).
    // Isso grava 1 linha REAL em coupon_redemptions (historico financeiro) — e o que
    // torna o cupom "ja usado". Nao falseamos a linha; usamos a funcao de checkout.
    const orderId = await insertOrder(client, slug);
    const redeem = runSeam<RedeemResult>("redeemCoupon", {
      couponId,
      orderId,
      userId,
      discountCents: 1500,
      perUserLimit: null,
      maxRedemptions: null,
    });
    expect(redeem.ok, `redencao deveria ter sucesso: ${JSON.stringify(redeem)}`).toBe(true);
    if (!redeem.ok) throw new Error("inalcancavel");
    expect(redeem.alreadyRedeemed, "redencao nova (nao repeticao)").toBe(false);

    // pre-condicao anti-trivial: existe >=1 linha REAL de redencao p/ este cupom (o
    // ramo 'in_use'). Sem isso o teste cairia no caminho unused-ok.
    const hasRedemption = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions" WHERE coupon_id = $1`,
      [couponId],
    );
    expect(
      Number(hasRedemption.rows[0].count),
      "cupom DEVE ter >=1 redencao real (esta feature e o caminho COM uso)",
    ).toBe(1);

    // baseline de audit GLOBAL antes do delete barrado.
    const baseAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const A0 = Number(baseAudit.rows[0].count);

    // ============================================================================
    // ACAO — TENTAR EXCLUIR: deleteCoupon(actor, id) de PRODUCAO (deve ser barrado).
    // ============================================================================
    const del = runSeam<CouponDeleteResult>("deleteCoupon", { actor: ACTOR, id: couponId });

    // === A1: ok:false com a mensagem de "ja foi utilizado" (in_use). ==================
    expect(del.ok, `exclusao de cupom usado deve FALHAR: ${JSON.stringify(del)}`).toBe(false);
    if (del.ok) throw new Error("inalcancavel: delete de cupom usado deveria ser ok:false");
    expect(
      del.error.startsWith("Cupom já foi utilizado"),
      `mensagem deve indicar in_use, veio: ${del.error}`,
    ).toBe(true);

    // === A2: a linha PERMANECE em coupons (nada apagado; FK Restrict + guarda). ========
    const afterDel = await client.query<{ count: string; is_active: boolean }>(
      `SELECT COUNT(*)::text AS count, BOOL_AND(is_active) AS is_active
         FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(
      Number(afterDel.rows[0].count),
      "a linha do cupom PERMANECE em coupons (delete barrado, nada apagado)",
    ).toBe(1);
    expect(
      afterDel.rows[0].is_active,
      "cupom continua ativo apos delete barrado (nada mudou no registro)",
    ).toBe(true);

    // a linha de redencao (historico financeiro) tambem sobrevive intacta.
    const redemptionStill = await client.query<{ count: string; discount_cents: number }>(
      `SELECT COUNT(*)::text AS count, MAX(discount_cents) AS discount_cents
         FROM "coupon_redemptions" WHERE coupon_id = $1`,
      [couponId],
    );
    expect(
      Number(redemptionStill.rows[0].count),
      "historico de redencao sobrevive (FK Restrict protegeu)",
    ).toBe(1);
    expect(
      redemptionStill.rows[0].discount_cents,
      "discount_cents do historico intacto (1500)",
    ).toBe(1500);

    // === A3: audit_log NAO ganha linha de coupon.delete (delta GLOBAL == 0). ===========
    const auditAfter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfter.rows[0].count),
      "delete barrado NAO grava nenhuma linha de audit (delta global 0)",
    ).toBe(A0);

    const delAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE action = 'coupon.delete' AND entity_id = $1`,
      [couponId],
    );
    expect(
      Number(delAudit.rows[0].count),
      "0 linhas coupon.delete para esse cupom (delete nunca procedeu)",
    ).toBe(0);

    // === A4: caminho correto e INATIVAR (setCouponActive false), nao excluir. ==========
    const deactivated = runSeam<CouponMutationResult>("setCouponActive", {
      actor: ACTOR,
      id: couponId,
      isActive: false,
    });
    expect(
      deactivated.ok,
      `inativar (caminho correto) deve ter sucesso: ${JSON.stringify(deactivated)}`,
    ).toBe(true);
    if (!deactivated.ok) throw new Error("inalcancavel");

    const afterDeactivate = await client.query<{ count: string; is_active: boolean }>(
      `SELECT COUNT(*)::text AS count, BOOL_AND(is_active) AS is_active
         FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(
      Number(afterDeactivate.rows[0].count),
      "inativar NAO apaga: cupom continua existindo (soft, nao hard)",
    ).toBe(1);
    expect(
      afterDeactivate.rows[0].is_active,
      "is_active == false: cupom saiu de circulacao sem ser excluido",
    ).toBe(false);

    // o registro de redencao continua intacto apos a inativacao (caminho correto).
    const redemptionAfterDeactivate = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions" WHERE coupon_id = $1`,
      [couponId],
    );
    expect(
      Number(redemptionAfterDeactivate.rows[0].count),
      "historico de redencao preservado apos inativacao",
    ).toBe(1);
  } finally {
    await client.end();
  }
});

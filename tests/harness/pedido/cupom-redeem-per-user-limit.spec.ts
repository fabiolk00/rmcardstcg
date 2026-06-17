import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.redeem.per-user-limit (priority 23) — DB-first, sem browser.
 *
 * Prova "Limite por usuario (perUserLimit) recontado na redencao" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * (cupom-redeem-global-limit.spec.ts / cupom-update-audited.spec.ts): roda em Node
 * (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: redeemCoupon(tx, input) de lib/data/coupons.ts (L364) — a funcao de
 * PRODUCAO de MENOR NIVEL que carrega a invariante coupon-redeem-limits. Na PRODUCAO ela
 * recebe um `tx` externo (corre DENTRO da transacao do checkout); o seam `redeemCoupon`
 * (tests/harness/estoque/_run-seam.ts — INFRA de teste ja existente, usada VERDE pela
 * feature irma global-limit) a envelopa num prisma.$transaction EXATAMENTE como o
 * checkout faz. Dentro da tx, quando input.perUserLimit !== null, a funcao: (1) verifica
 * idempotencia por pedido (coupon_redemptions.order_id UNIQUE — aqui sempre pedidos
 * DISTINTOS, ramo nao exercitado); (2) pega advisory lock por (cupom,usuario) via
 * pg_advisory_xact_lock(hashtextextended('coupon:<id>:<user>',0)) e RECONTA
 * coupon_redemptions p/ esse (couponId,userId); se used >= perUserLimit retorna
 * { ok:false, reason:'per_user_limit' } SEM increment global e SEM inserir; (3) senao faz
 * o increment global e insere 1 linha. Quando ok:false o checkout de PRODUCAO aborta a
 * transacao inteira (rollback) — o seam espelha isso (RedeemAbort) e re-emite o { ok:false }
 * apos o rollback, garantindo que nada parcial persistiu. NAO chamamos a server action /
 * o checkout completo (HTTP, requireAdmin/Clerk/Asaas, fora do escopo); a redencao e a
 * unidade que carrega a invariante.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a MUTACAO (createCoupon/redeemCoupon) roda num processo `tsx` separado
 * (_run-seam.ts), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * DADOS PROPRIOS (anti-trivialidade): cupom percent PROPRIO com perUserLimit=1 E
 * maxRedemptions=null (criado via createCoupon de PRODUCAO; code unico por run). Limite
 * GLOBAL nulo (ilimitado) p/ isolar a causa: a 2a redencao so pode falhar pelo LIMITE POR
 * USUARIO, nunca pelo teto global. DOIS pedidos PROPRIOS distintos (orderA != orderB) do
 * MESMO usuario, pois coupon_redemptions.order_id e UNIQUE — a 2a tentativa precisa de
 * OUTRO pedido p/ provar que e o perUserLimit (e nao a idempotencia por pedido) que barra.
 * perUserLimit=1 (e nao um numero alto) garante que a 2a redencao do mesmo usuario realmente
 * esbarra no teto por usuario.
 *
 * Asserts do ledger (3/3 provados via pg):
 *  A1 "Primeira redencao do usuario: ok": retorno ok:true/alreadyRedeemed:false; apos ela
 *     ha 1 linha em coupon_redemptions p/ (couponId,userId).
 *  A2 "Segunda do MESMO usuario: ok:false reason='per_user_limit'": retorno ok:false/
 *     reason='per_user_limit'; nenhuma linha nova (rollback total — a recontagem sob o
 *     advisory lock viu used>=limit e abortou antes de incrementar/inserir).
 *  A3 "coupon_redemptions tem 1 linha para esse (couponId,userId); recontagem sob advisory
 *     lock por (cupom,usuario) garante o limite": exatamente 1 linha p/ (coupon_id,
 *     clerk_user_id) (a do orderA; orderB NAO deixou linha). Sanity adicional: como
 *     maxRedemptions=null, o teto global nao participou — redeemed_count == 1 (incrementado
 *     so 1x), provando que foi o perUserLimit (e nao o global) que barrou a 2a.
 *
 * Invariante coberta: coupon-redeem-limits (limite por usuario recontado atomicamente sob
 * advisory lock por (cupom,usuario); nenhuma redencao alem do teto por usuario).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type CouponMutationResult =
  | { ok: false; error: string }
  | { ok: true; coupon: { id: string; code: string; redeemedCount: number } };

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

/** Cria um pedido PROPRIO minimo (INSERT direto em pg) e devolve seu id. */
async function insertOrder(client: Client, tag: string, userId: string): Promise<number> {
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
    [userId, "Cliente Harness", `cliente-${tag}@harness.test`, "11999999999"],
  );
  return ins.rows[0].id;
}

test("cupom.redeem.per-user-limit: 1a redencao do usuario ok, 2a do MESMO usuario barra em per_user_limit, 1 linha de redencao", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const code = `PUL-${tag}`;
    const userId = `user-${tag}`;
    const PER_USER = 1; // teto por usuario = 1 (2a redencao do mesmo user DEVE bater no limite)

    // --- setup A: cupom PROPRIO percent, perUserLimit=1, maxRedemptions=null (via PRODUCAO).
    // maxRedemptions=null (ilimitado) ISOLA a causa: a 2a redencao so pode falhar pelo
    // limite POR USUARIO, nunca pelo teto global.
    const created = runSeam<CouponMutationResult>("createCoupon", {
      actor: ACTOR,
      input: {
        code,
        type: "percent",
        percentOff: 10,
        valueCents: null,
        minSubtotalCents: 0,
        maxRedemptions: null, // global ilimitado p/ isolar o limite por usuario
        perUserLimit: PER_USER,
        isActive: true,
        startsAt: null,
        expiresAt: null,
      },
    });
    expect(created.ok, `criacao do cupom deveria ter sucesso: ${JSON.stringify(created)}`).toBe(
      true,
    );
    if (!created.ok) throw new Error("inalcancavel");
    const couponId = created.coupon.id;
    expect(couponId).toBeTruthy();

    // Pre-estado: perUserLimit=1, maxRedemptions NULL, redeemedCount=0 (anti-trivial —
    // partimos de zero redencoes para esse usuario).
    const pre = await client.query<{
      redeemed_count: number;
      per_user_limit: number;
      max_redemptions: number | null;
    }>(`SELECT redeemed_count, per_user_limit, max_redemptions FROM "coupons" WHERE id = $1`, [
      couponId,
    ]);
    expect(pre.rows[0].redeemed_count, "pre: redeemed_count=0").toBe(0);
    expect(pre.rows[0].per_user_limit, "pre: per_user_limit=1").toBe(PER_USER);
    expect(pre.rows[0].max_redemptions, "pre: max_redemptions NULL (global ilimitado)").toBeNull();

    // --- setup B: DOIS pedidos PROPRIOS distintos do MESMO usuario (order_id UNIQUE + FK).
    const orderA = await insertOrder(client, `${tag}-a`, userId);
    const orderB = await insertOrder(client, `${tag}-b`, userId);
    expect(orderA).not.toBe(orderB);

    // === A1: 1a redencao do usuario (orderA) -> ok, alreadyRedeemed=false. ================
    const r1 = runSeam<RedeemResult>("redeemCoupon", {
      couponId,
      orderId: orderA,
      userId,
      discountCents: 1000,
      perUserLimit: PER_USER,
      maxRedemptions: null,
    });
    expect(r1.ok, `1a redencao deve ser ok: ${JSON.stringify(r1)}`).toBe(true);
    if (!r1.ok) throw new Error("inalcancavel");
    expect(r1.alreadyRedeemed, "1a redencao nao e repeticao (alreadyRedeemed=false)").toBe(false);

    // Apos a 1a: exatamente 1 linha de redencao p/ (couponId,userId).
    const afterFirst = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions"
         WHERE coupon_id = $1 AND clerk_user_id = $2`,
      [couponId, userId],
    );
    expect(
      Number(afterFirst.rows[0].count),
      "apos 1a redencao: 1 linha em coupon_redemptions p/ (couponId,userId)",
    ).toBe(1);

    // === A2: 2a redencao do MESMO usuario (orderB, OUTRO pedido) -> ok:false
    //          reason='per_user_limit'; nada gravado (rollback). =========================
    const r2 = runSeam<RedeemResult>("redeemCoupon", {
      couponId,
      orderId: orderB,
      userId, // MESMO usuario — esbarra no perUserLimit recontado sob advisory lock
      discountCents: 1000,
      perUserLimit: PER_USER,
      maxRedemptions: null,
    });
    expect(r2.ok, "2a redencao do mesmo usuario (teto por usuario) deve falhar").toBe(false);
    if (r2.ok) throw new Error("inalcancavel: 2a redencao deveria ser ok:false");
    expect(r2.reason, "reason deve ser 'per_user_limit'").toBe("per_user_limit");

    // === A3: coupon_redemptions tem EXATAMENTE 1 linha p/ (couponId,userId); a do orderA. =
    const redemptions = await client.query<{ order_id: number }>(
      `SELECT order_id FROM "coupon_redemptions"
         WHERE coupon_id = $1 AND clerk_user_id = $2`,
      [couponId, userId],
    );
    expect(
      redemptions.rowCount,
      "exatamente 1 linha de redencao p/ (couponId,userId) (recontagem barra a 2a)",
    ).toBe(1);
    expect(redemptions.rows[0].order_id, "a unica redencao e a do orderA").toBe(orderA);

    // orderB NAO deixou linha (a 2a tentativa, barrada pelo perUserLimit, deu rollback total).
    const forOrderB = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions" WHERE order_id = $1`,
      [orderB],
    );
    expect(Number(forOrderB.rows[0].count), "orderB nao deixou linha de redencao").toBe(0);

    // Sanity: como maxRedemptions=null, o teto global nao participou. redeemed_count == 1
    // (incrementado so na 1a redencao) prova que foi o perUserLimit — e nao o global —
    // que barrou a 2a; a recontagem aborta ANTES do increment global.
    const counter = await client.query<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(
      counter.rows[0].redeemed_count,
      "redeemed_count == 1 (so a 1a redencao incrementou; a 2a abortou antes do increment global)",
    ).toBe(1);
    expect(Number.isInteger(counter.rows[0].redeemed_count)).toBe(true);

    // CHECK redeemed_count>=0 nunca violado (rede de seguranca do DB).
    const viol = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupons"
         WHERE NOT (redeemed_count >= 0
           AND (max_redemptions IS NULL OR redeemed_count <= max_redemptions))`,
    );
    expect(
      Number(viol.rows[0].count),
      "nenhum cupom viola redeemed_count>=0 nem o teto redeemed_count<=max",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

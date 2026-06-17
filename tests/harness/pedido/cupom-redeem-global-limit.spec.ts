import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.redeem.global-limit (priority 22) — DB-first, sem browser.
 *
 * Prova "Limite global de redencoes (maxRedemptions) e atomico" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * (cupom-update-audited.spec.ts / payment-pending-to-paid.spec.ts): roda em Node
 * (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: redeemCoupon(tx, input) de lib/data/coupons.ts (L364) — a funcao
 * de PRODUCAO de MENOR NIVEL que prova a invariante coupon-redeem-limits. Na PRODUCAO
 * ela recebe um `tx` externo (corre DENTRO da transacao do checkout); o seam
 * `redeemCoupon` (tests/harness/estoque/_run-seam.ts, ADICIONADO nesta sessao — INFRA
 * de teste, nenhum codigo de produto tocado) a envelopa num prisma.$transaction
 * EXATAMENTE como o checkout faz. Dentro da tx a funcao: (1) idempotencia por pedido
 * via coupon_redemptions.order_id UNIQUE; (2) recontagem por usuario sob advisory lock
 * quando perUserLimit!=null (aqui perUserLimit=null, ramo nao exercitado); (3) INCREMENT
 * ATOMICO do limite global via updateMany WHERE id=cupom AND (max IS NULL OR
 * redeemed_count < max) — count==0 => esgotado, retorna { ok:false,
 * reason:'max_redemptions' } SEM inserir nem incrementar; (4) senao insere 1 linha em
 * coupon_redemptions. Quando ok:false o checkout de PRODUCAO aborta a transacao inteira
 * (rollback) — o seam espelha isso (RedeemAbort) e re-emite o { ok:false } apos o
 * rollback, garantindo que nada parcial persistiu. NAO chamamos a server action / o
 * checkout completo (HTTP, requireAdmin/Clerk/Asaas, fora do escopo); a redencao e a
 * unidade que carrega a invariante.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a MUTACAO (createCoupon/redeemCoupon) roda num processo `tsx` separado
 * (_run-seam.ts), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * DADOS PROPRIOS (anti-trivialidade): cupom percent PROPRIO com maxRedemptions=1 e
 * redeemedCount=0 (criado via createCoupon de PRODUCAO; code unico por run). DOIS pedidos
 * PROPRIOS distintos (orderA != orderB), pois coupon_redemptions.order_id e UNIQUE e tem
 * FK p/ orders.id — a segunda tentativa precisa de OUTRO pedido p/ provar que e o limite
 * GLOBAL (e nao a idempotencia por pedido) que barra. maxRedemptions=1 (e nao um numero
 * alto) garante que a 2a redencao realmente esbarra no teto.
 *
 * Asserts do ledger (3/3 provados via pg):
 *  A1 "1a redencao: ok, alreadyRedeemed=false; redeemed_count==1 (increment CAS WHERE
 *     redeemed_count < max)": retorno ok:true/alreadyRedeemed:false; coluna crua
 *     redeemed_count == 1 (era 0).
 *  A2 "2a redencao (outro pedido): ok:false reason='max_redemptions'; redeemed_count
 *     permanece 1": retorno ok:false/reason='max_redemptions'; redeemed_count segue == 1
 *     (sem increment parcial — o updateMany do CAS casou 0 linhas e a tx deu rollback).
 *  A3 "coupon_redemptions tem 1 linha; CHECK redeemed_count>=0 e <=max preservado":
 *     exatamente 1 linha em coupon_redemptions p/ esse cupom (a do orderA; orderB NAO
 *     deixou linha); CHECK coupons_redeemed_count_chk (>=0) existe e 0 violacoes; o teto
 *     logico redeemed_count<=max (1<=1) e respeitado pelo CAS atomico.
 *
 * Invariante coberta: coupon-redeem-limits (limite global atomico via CAS; nenhuma
 * redencao alem do teto; contador e tabela de redencoes coerentes).
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

test("cupom.redeem.global-limit: 1a redencao incrementa atomico, 2a barra em max_redemptions, 1 linha de redencao", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- sanity: o CHECK coupons_redeemed_count_chk existe (senao a guarda seria vacua).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'coupons_redeemed_count_chk'`,
    );
    expect(chk.rowCount, "CHECK coupons_redeemed_count_chk (>=0) deve existir").toBe(1);

    const tag = randomUUID().slice(0, 8);
    const code = `GLB-${tag}`;
    const userId = `user-${tag}`;
    const MAX = 1; // teto global = 1 (2a redencao DEVE bater no limite)

    // --- setup A: cupom PROPRIO percent, maxRedemptions=1, redeemedCount=0 (via PRODUCAO).
    const created = runSeam<CouponMutationResult>("createCoupon", {
      actor: ACTOR,
      input: {
        code,
        type: "percent",
        percentOff: 10,
        valueCents: null,
        minSubtotalCents: 0,
        maxRedemptions: MAX,
        perUserLimit: null, // ramo per-user nao exercitado aqui (feature irma cobre)
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

    // Pre-estado do contador: 0 (anti-trivial — partimos de 0, nao de algo perto do teto).
    const preCount = await client.query<{ redeemed_count: number; max_redemptions: number }>(
      `SELECT redeemed_count, max_redemptions FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(preCount.rows[0].redeemed_count, "pre: redeemed_count=0").toBe(0);
    expect(preCount.rows[0].max_redemptions, "pre: max_redemptions=1").toBe(MAX);

    // --- setup B: DOIS pedidos PROPRIOS distintos (order_id UNIQUE + FK p/ orders.id).
    const orderA = await insertOrder(client, `${tag}-a`);
    const orderB = await insertOrder(client, `${tag}-b`);
    expect(orderA).not.toBe(orderB);

    // === A1: 1a redencao (orderA) -> ok, alreadyRedeemed=false; redeemed_count vira 1. ==
    const r1 = runSeam<RedeemResult>("redeemCoupon", {
      couponId,
      orderId: orderA,
      userId,
      discountCents: 1000,
      perUserLimit: null,
      maxRedemptions: MAX,
    });
    expect(r1.ok, `1a redencao deve ser ok: ${JSON.stringify(r1)}`).toBe(true);
    if (!r1.ok) throw new Error("inalcancavel");
    expect(r1.alreadyRedeemed, "1a redencao nao e repeticao (alreadyRedeemed=false)").toBe(false);

    const afterFirst = await client.query<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(
      afterFirst.rows[0].redeemed_count,
      "redeemed_count == 1 (increment atomico CAS WHERE redeemed_count < max)",
    ).toBe(1);
    expect(Number.isInteger(afterFirst.rows[0].redeemed_count)).toBe(true);

    // === A2: 2a redencao (orderB, OUTRO pedido) -> ok:false reason='max_redemptions';
    //          redeemed_count permanece 1 (sem increment parcial). ==========================
    const r2 = runSeam<RedeemResult>("redeemCoupon", {
      couponId,
      orderId: orderB,
      userId,
      discountCents: 1000,
      perUserLimit: null,
      maxRedemptions: MAX,
    });
    expect(r2.ok, "2a redencao (teto atingido) deve falhar").toBe(false);
    if (r2.ok) throw new Error("inalcancavel: 2a redencao deveria ser ok:false");
    expect(r2.reason, "reason deve ser 'max_redemptions'").toBe("max_redemptions");

    const afterSecond = await client.query<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(
      afterSecond.rows[0].redeemed_count,
      "redeemed_count permanece 1 (2a redencao nao incrementou; rollback)",
    ).toBe(1);

    // === A3: coupon_redemptions tem EXATAMENTE 1 linha (a do orderA); CHECK >=0 e teto. ==
    const redemptions = await client.query<{ order_id: number; count: string }>(
      `SELECT order_id FROM "coupon_redemptions" WHERE coupon_id = $1`,
      [couponId],
    );
    expect(redemptions.rowCount, "exatamente 1 linha de redencao p/ esse cupom").toBe(1);
    expect(redemptions.rows[0].order_id, "a unica redencao e a do orderA").toBe(orderA);

    // orderB NAO deixou linha (a tentativa que falhou deu rollback total).
    const forOrderB = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions" WHERE order_id = $1`,
      [orderB],
    );
    expect(Number(forOrderB.rows[0].count), "orderB nao deixou linha de redencao").toBe(0);

    // CHECK redeemed_count>=0 nunca violado (rede de seguranca do DB); teto logico 1<=max.
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

import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: cupom.redeem.idempotent-per-order (priority 24) — DB-first, sem browser.
 *
 * Prova "Redencao e idempotente por pedido (order_id UNIQUE)" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas VERDES
 * (cupom-redeem-global-limit.spec.ts / cupom-redeem-per-user-limit.spec.ts): roda em
 * Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: redeemCoupon(tx, input) de lib/data/coupons.ts (L364) — a funcao de
 * PRODUCAO de MENOR NIVEL que carrega a invariante coupon-redeem-limits (aqui o ramo de
 * IDEMPOTENCIA POR PEDIDO). Na PRODUCAO ela recebe um `tx` externo (corre DENTRO da
 * transacao do checkout); o seam `redeemCoupon` (tests/harness/estoque/_run-seam.ts —
 * INFRA de teste ja existente, usada VERDE pelas features irmas global-limit/per-user-limit)
 * a envelopa num prisma.$transaction EXATAMENTE como o checkout faz. A PRIMEIRA coisa que
 * redeemCoupon faz (L375-376) e:
 *     const existing = await tx.couponRedemption.findUnique({ where: { orderId } });
 *     if (existing) return { ok:true, alreadyRedeemed:true };
 * ou seja: se JA existe uma linha de redencao p/ aquele orderId (order_id @unique), a
 * funcao retorna no-op SEM pegar advisory lock, SEM increment global e SEM inserir 2a
 * linha. NAO chamamos a server action / o checkout completo (HTTP, requireAdmin/Clerk/
 * Asaas, fora do escopo); a redencao e a unidade que carrega a invariante.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso a MUTACAO (createCoupon/redeemCoupon) roda num processo `tsx` separado
 * (_run-seam.ts), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * DADOS PROPRIOS (anti-trivialidade): cupom percent PROPRIO com maxRedemptions=1 E
 * perUserLimit=null (criado via createCoupon de PRODUCAO; code unico por run). Por que
 * maxRedemptions=1 e nao null: torna a assercao "NAO incrementa na repeticao" LOAD-BEARING
 * — se a 2a redencao (repeticao) ERRADAMENTE incrementasse redeemed_count, iria p/ 2 > max=1,
 * estourando o CHECK coupons_redeemed_count_chk e/ou criando uma 2a linha; o teste pegaria.
 * Com a idempotencia correta o findUnique curto-circuita ANTES do increment, entao
 * redeemed_count fica em 1. perUserLimit=null isola o ramo: nem o teto global nem o por
 * usuario sao reavaliados na repeticao — a unica coisa que barra a 2a e o order_id @unique.
 * UM pedido PROPRIO (orderX); a repeticao usa o MESMO orderX (e isso que prova a
 * idempotencia por pedido).
 *
 * Asserts do ledger (3/3 provados via pg):
 *  A1 "Segunda chamada retorna ok:true alreadyRedeemed=true (no-op)": 1a redencao do orderX
 *     retorna ok:true/alreadyRedeemed=false; 2a redencao do MESMO orderX retorna ok:true/
 *     alreadyRedeemed=true (no-op).
 *  A2 "coupon_redemptions tem 1 unica linha para orderId X (order_id @unique)": exatamente
 *     1 linha p/ order_id=orderX antes e depois da repeticao (a 2a nao inseriu nada).
 *  A3 "coupons.redeemed_count NAO incrementa na repeticao": redeemed_count == 1 apos a 1a
 *     redencao E continua == 1 apos a 2a (a repeticao nao mexeu no contador global).
 *
 * Invariante coberta: coupon-redeem-limits (idempotencia por pedido via
 * coupon_redemptions.order_id UNIQUE; redimir o mesmo pedido 2x = no-op).
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

test("cupom.redeem.idempotent-per-order: redimir o MESMO pedido 2x e no-op (alreadyRedeemed=true, 1 linha, sem increment)", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- sanity: o CHECK coupons_redeemed_count_chk existe (senao a rede final do "sem
    // increment indevido" seria vacua) e o indice UNIQUE de order_id existe (a fonte da
    // idempotencia por pedido).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'coupons_redeemed_count_chk'`,
    );
    expect(chk.rowCount, "CHECK coupons_redeemed_count_chk (>=0) deve existir").toBe(1);
    const uniq = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
         WHERE tablename = 'coupon_redemptions' AND indexdef ILIKE '%UNIQUE%order_id%'`,
    );
    expect(
      uniq.rowCount,
      "indice UNIQUE em coupon_redemptions.order_id deve existir (fonte da idempotencia)",
    ).toBe(1);

    const tag = randomUUID().slice(0, 8);
    const code = `IDP-${tag}`;
    const userId = `user-${tag}`;
    const MAX = 1; // teto global = 1: torna a assercao "sem increment na repeticao" load-bearing

    // --- setup A: cupom PROPRIO percent, maxRedemptions=1, perUserLimit=null (via PRODUCAO).
    // perUserLimit=null isola a causa: na repeticao nem o teto global nem o por usuario sao
    // reavaliados — o unico guard que barra a 2a redencao do MESMO pedido e o order_id @unique.
    const created = runSeam<CouponMutationResult>("createCoupon", {
      actor: ACTOR,
      input: {
        code,
        type: "percent",
        percentOff: 10,
        valueCents: null,
        minSubtotalCents: 0,
        maxRedemptions: MAX,
        perUserLimit: null,
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

    // Pre-estado: maxRedemptions=1, redeemedCount=0 (anti-trivial — partimos de zero).
    const pre = await client.query<{ redeemed_count: number; max_redemptions: number | null }>(
      `SELECT redeemed_count, max_redemptions FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(pre.rows[0].redeemed_count, "pre: redeemed_count=0").toBe(0);
    expect(pre.rows[0].max_redemptions, "pre: max_redemptions=1").toBe(MAX);

    // --- setup B: UM pedido PROPRIO (orderX); a repeticao usa o MESMO orderX.
    const orderX = await insertOrder(client, tag, userId);
    expect(orderX).toBeTruthy();

    // === A1 (parte 1): 1a redencao do orderX -> ok, alreadyRedeemed=false. ================
    const r1 = runSeam<RedeemResult>("redeemCoupon", {
      couponId,
      orderId: orderX,
      userId,
      discountCents: 1000,
      perUserLimit: null,
      maxRedemptions: MAX,
    });
    expect(r1.ok, `1a redencao deve ser ok: ${JSON.stringify(r1)}`).toBe(true);
    if (!r1.ok) throw new Error("inalcancavel");
    expect(r1.alreadyRedeemed, "1a redencao nao e repeticao (alreadyRedeemed=false)").toBe(false);

    // Apos a 1a redencao: 1 linha p/ orderX e redeemed_count==1 (baseline da idempotencia).
    const afterFirstRows = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions" WHERE order_id = $1`,
      [orderX],
    );
    expect(Number(afterFirstRows.rows[0].count), "apos 1a: 1 linha p/ orderX").toBe(1);
    const afterFirstCount = await client.query<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(afterFirstCount.rows[0].redeemed_count, "apos 1a: redeemed_count=1").toBe(1);

    // === A1 (parte 2): 2a redencao do MESMO orderX -> ok:true, alreadyRedeemed=TRUE (no-op). =
    const r2 = runSeam<RedeemResult>("redeemCoupon", {
      couponId,
      orderId: orderX, // MESMO pedido — order_id @unique dispara a idempotencia
      userId,
      discountCents: 1000,
      perUserLimit: null,
      maxRedemptions: MAX,
    });
    expect(r2.ok, `2a redencao (mesmo pedido) deve ser ok:true no-op: ${JSON.stringify(r2)}`).toBe(
      true,
    );
    if (!r2.ok) throw new Error("inalcancavel");
    expect(
      r2.alreadyRedeemed,
      "2a redencao do MESMO pedido e repeticao (alreadyRedeemed=true)",
    ).toBe(true);

    // === A2: coupon_redemptions tem EXATAMENTE 1 linha p/ orderX (a 2a nao inseriu). =======
    const rowsForOrder = await client.query<{ id: string; user_id: string }>(
      `SELECT id, clerk_user_id AS user_id FROM "coupon_redemptions" WHERE order_id = $1`,
      [orderX],
    );
    expect(
      rowsForOrder.rowCount,
      "exatamente 1 linha de redencao p/ orderX (idempotencia por pedido)",
    ).toBe(1);
    expect(rowsForOrder.rows[0].user_id, "a unica linha e a do usuario da 1a redencao").toBe(
      userId,
    );

    // === A3: coupons.redeemed_count NAO incrementou na repeticao (continua == 1). ==========
    const afterSecondCount = await client.query<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(
      afterSecondCount.rows[0].redeemed_count,
      "redeemed_count continua 1 apos a repeticao (no-op nao incrementa o contador global)",
    ).toBe(1);
    expect(Number.isInteger(afterSecondCount.rows[0].redeemed_count)).toBe(true);

    // Rede final do DB: redeemed_count>=0 e <=max jamais violado (com MAX=1, um increment
    // indevido teria estourado isto — prova adicional de que o no-op NAO incrementou).
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

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.coupon.per-user-race (priority 33, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB CONCORRENCIA REAL que um cupom com perUserLimit=1 (maxRedemptions=null)
 * resgatado pelo MESMO usuario em N>=10 pedidos DISTINTOS, via N transacoes
 * concorrentes, e aceito EXATAMENTE 1 vez — over-redeem POR USUARIO e impossivel —
 * contra o Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner.
 *
 * SEAM escolhida: redeemCoupon(tx, input) de lib/data/coupons.ts (L364) — a MESMA
 * funcao de PRODUCAO que o checkout chama. A anti-corrida do limite POR USUARIO vive
 * nela e NAO depende de SSI: quando input.perUserLimit !== null a funcao serializa
 * redencoes do MESMO (cupom,usuario) com um advisory lock TRANSACIONAL e so entao
 * reconta:
 *   const lockKey = `coupon:${couponId}:${userId}`;
 *   await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
 *   const used = await tx.couponRedemption.count({ where: { couponId, userId } });
 *   if (used >= perUserLimit) return { ok:false, reason:'per_user_limit' };
 *   ... increment global (CAS) + couponRedemption.create ...
 * Sob N transacoes concorrentes do MESMO (cupom,usuario), o pg_advisory_xact_lock
 * (escopo de transacao, liberado so no commit/rollback) ENFILEIRA os racers: o 1o
 * adquire o lock, reconta used=0 (< 1), incrementa, insere a linha e COMMITA — so
 * entao libera o lock; cada um dos N-1 seguintes adquire o lock NA SEQUENCIA, reconta
 * used>=1 (ja enxergando a redencao commitada do vencedor) e volta
 * { ok:false, reason:'per_user_limit' } SEM increment global e SEM inserir. O seam
 * runner (_run-seam.ts, op "redeemCoupon" — INFRA de teste ja existente, VERDE nas
 * features irmas per-user-limit/global-limit/over-redeem) envelopa redeemCoupon num
 * prisma.$transaction EXATAMENTE como o checkout; em ok:false lanca RedeemAbort p/
 * forcar o ROLLBACK (espelha o checkout abortando a tx inteira), garantindo que nada
 * parcial persistiu (sem increment, sem linha em coupon_redemptions). Chamamos a funcao
 * de PRODUCAO direto, sem mock — a server action/checkout so monta o input apos validar
 * carrinho/preco (irrelevante p/ a invariante e inacessivel sem o middleware Proxy).
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE SEGURO (anti-fake-green):
 * disparamos N>=10 processos `tsx` SIMULTANEOS via `spawn` assincrono + Promise.all —
 * NAO `spawnSync` (que serializaria e tornaria o teste trivial). Cada racer e um
 * processo/transacao independente no MESMO Postgres, resgatando o MESMO cupom como o
 * MESMO usuario p/ um orderId DISTINTO (entao a idempotencia por pedido —
 * coupon_redemptions.order_id UNIQUE — NUNCA curto-circuita: cada um e um pedido novo).
 * maxRedemptions=null isola a causa: o teto GLOBAL nao participa (CAS sem limite sempre
 * incrementaria) — a UNICA barreira e a recontagem POR USUARIO sob o advisory lock. Se
 * o produto NAO serializasse (ex.: recontagem sob READ COMMITTED sem advisory lock),
 * dois racers leriam used=0 concorrentemente, ambos passariam o teto por usuario e
 * inseririam -> 2 linhas p/ o (cupom,usuario) e redeemed_count==2 (over-redeem por
 * usuario!). O teste exige EXATAMENTE 1 ok:true, 1 linha de redencao p/ (cupom,usuario)
 * e redeemed_count==1, entao qualquer corrida insegura o reprova.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso as MUTACOES rodam em processos `tsx` separados (tests/harness/estoque/_run-seam.ts),
 * herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Asserts canonicos da feature (4/4 provados via pg):
 *  A1 "Exatamente 1 resgate do usuario passa; o outro ok:false reason='per_user_limit'":
 *     dos N retornos do seam, exatamente 1 e ok:true/alreadyRedeemed:false; os N-1
 *     restantes sao ok:false/reason='per_user_limit' (nenhum P-error vazado).
 *  A2 "coupon_redemptions tem exatamente 1 linha p/ (couponId,userId); nenhuma 2a do
 *     mesmo usuario": COUNT WHERE coupon_id e clerk_user_id == 1; e a do pedido vencedor.
 *  A3 "coupons.redeemed_count reflete apenas o resgate aceito (==1); sem incremento duplo":
 *     coluna crua redeemed_count == 1 (incrementado so pela redencao do vencedor).
 *  A4 "Cada linha de coupon_redemptions permanece unica por order_id (order_id @unique)":
 *     order_id e UNIQUE; os N-1 pedidos perdedores nao deixaram linha (rollback total).
 *
 * Invariante coberta: coupon-redeem-limits (limite por usuario recontado atomicamente
 * sob advisory lock por (cupom,usuario); nenhuma redencao alem do teto por usuario,
 * mesmo sob corrida real no Postgres).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type CouponMutationResult =
  | { ok: false; error: string }
  | { ok: true; coupon: { id: string; code: string; redeemedCount: number } };

type RedeemResult = { ok: true; alreadyRedeemed: boolean } | { ok: false; reason: string };

/** Payload de redencao enviado ao seam (espelha o input de redeemCoupon de PRODUCAO). */
type RedeemPayload = {
  couponId: string;
  orderId: number;
  userId: string;
  discountCents: number;
  perUserLimit: number | null;
  maxRedemptions: number | null;
};

/** Desfecho de um dos N resgates concorrentes (correlaciona resultado/erro). */
type RedeemOutcome = {
  racerId: number;
  orderId: number;
  result: RedeemResult | null;
  error: string | null;
};

/** Chama uma op do seam via processo tsx SINCRONO (setup serial). */
function runSeamSync<T>(op: string, payload: unknown): T {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
    encoding: "utf8",
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32",
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

/**
 * Resgata um cupom via processo tsx ASSINCRONO. RETORNA uma Promise que so resolve
 * quando o processo termina — permitindo que N resgates rodem em paralelo REAL via
 * Promise.all (cada um e um processo/transacao independente no MESMO Postgres,
 * disputando o advisory lock por (cupom,usuario) do MESMO par). Resolve sempre (nunca
 * rejeita) com o resultado do seam ou um erro de processo, para que Promise.all colete
 * TODOS os desfechos.
 */
function redeemAsync(racerId: number, payload: RedeemPayload): Promise<RedeemOutcome> {
  return new Promise<RedeemOutcome>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", SEAM_RUNNER, "redeemCoupon"], {
      env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) =>
      resolve({
        racerId,
        orderId: payload.orderId,
        result: null,
        error: `spawn error: ${e.message}`,
      }),
    );
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          racerId,
          orderId: payload.orderId,
          result: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as RedeemResult,
          error: null,
        });
        return;
      }
      if (errLine) {
        const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
        resolve({
          racerId,
          orderId: payload.orderId,
          result: null,
          error: `${e.name}: ${e.message}`,
        });
        return;
      }
      resolve({
        racerId,
        orderId: payload.orderId,
        result: null,
        error: `seam runner sem resultado (status ${status}):\n${stdout}\n${stderr}`,
      });
    });
  });
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const ACTOR = { clerkUserId: null, email: null, role: null };

const N = 12; // resgates concorrentes do MESMO (cupom,usuario) (>=10, exige o advisory lock)
const PER_USER = 1; // teto por usuario = 1 (so 1 redencao do usuario pode vencer)

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

test("chaos.coupon.per-user-race: N resgates concorrentes do MESMO usuario com perUserLimit=1, exatamente 1 vence (sem over-redeem por usuario)", async () => {
  // N processos tsx concorrentes (cada um sobe um Prisma) sob Windows: folga ampla.
  test.setTimeout(240_000);

  const client = makeClient();
  await client.connect();
  try {
    // --- sanity: o CHECK coupons_redeemed_count_chk existe (senao a rede final seria vacua).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'coupons_redeemed_count_chk'`,
    );
    expect(chk.rowCount, "CHECK coupons_redeemed_count_chk (>=0) deve existir").toBe(1);

    const tag = randomUUID().slice(0, 8);
    const code = `PUR-${tag}`;
    const userId = `user-${tag}`; // MESMO usuario em TODOS os N resgates

    // --- setup A: cupom PROPRIO percent, perUserLimit=1, maxRedemptions=null (via PRODUCAO).
    //     maxRedemptions=null (global ilimitado) ISOLA a causa: o teto GLOBAL nao participa
    //     da corrida (o CAS sem limite sempre incrementaria) — a UNICA barreira e a
    //     recontagem POR USUARIO sob o advisory lock. Partimos de redeemedCount=0
    //     (anti-trivial): a corrida disputa genuinamente o 0->1 do MESMO usuario.
    const created = runSeamSync<CouponMutationResult>("createCoupon", {
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

    const preCount = await client.query<{
      redeemed_count: number;
      per_user_limit: number;
      max_redemptions: number | null;
    }>(`SELECT redeemed_count, per_user_limit, max_redemptions FROM "coupons" WHERE id = $1`, [
      couponId,
    ]);
    expect(preCount.rows[0].redeemed_count, "pre: redeemed_count=0").toBe(0);
    expect(preCount.rows[0].per_user_limit, "pre: per_user_limit=1").toBe(PER_USER);
    expect(
      preCount.rows[0].max_redemptions,
      "pre: max_redemptions NULL (global ilimitado)",
    ).toBeNull();

    // --- setup B: N pedidos PROPRIOS DISTINTOS, TODOS do MESMO usuario (order_id UNIQUE +
    //     FK p/ orders.id). orderIds distintos => a idempotencia por pedido NUNCA
    //     curto-circuita; o que barra os perdedores e o teto POR USUARIO, nao o order_id.
    const orderIds: number[] = [];
    for (let i = 0; i < N; i++) {
      orderIds.push(await insertOrder(client, `${tag}-${i}`, userId));
    }
    expect(new Set(orderIds).size, "todos os N pedidos sao distintos").toBe(N);

    // --- ACAO: dispara os N resgates SIMULTANEOS do MESMO cupom pelo MESMO usuario
    //     (orderIds distintos). Promise.all sobre processos spawn() assincronos =>
    //     paralelismo REAL: todos os tsx correm ao mesmo tempo, cada um numa transacao
    //     independente, disputando o advisory lock TRANSACIONAL por (cupom,usuario). NAO
    //     ha serializacao artificial (spawnSync seria serial e trivial) — a unica
    //     serializacao e a do PROPRIO produto (pg_advisory_xact_lock).
    const outcomes = await Promise.all(
      orderIds.map((orderId, i) =>
        redeemAsync(i, {
          couponId,
          orderId,
          userId, // MESMO usuario em todos os racers
          discountCents: 1000,
          perUserLimit: PER_USER,
          maxRedemptions: null,
        }),
      ),
    );

    // Nenhum resgate pode vazar erro de processo/Prisma: cada um termina ou ok:true
    // (vencedor) ou ok:false/reason='per_user_limit' (perdedor recuperado pela funcao).
    const processFailures = outcomes.filter((o) => o.result === null);
    expect(
      processFailures,
      `nenhum resgate pode vazar erro (perdedor deve virar reason='per_user_limit'):\n${JSON.stringify(
        processFailures,
        null,
        2,
      )}`,
    ).toHaveLength(0);

    // --- ASSERT 1 (asserts#1): EXATAMENTE 1 resgate do usuario passa; os N-1 restantes
    //     retornam ok:false reason='per_user_limit' (a recontagem sob advisory lock por
    //     (cupom,usuario) serializa a corrida e barra todos depois do 1o).
    const winners = outcomes.filter((o) => o.result?.ok === true) as Array<
      RedeemOutcome & { result: { ok: true; alreadyRedeemed: boolean } }
    >;
    const losers = outcomes.filter((o) => o.result?.ok === false) as Array<
      RedeemOutcome & { result: { ok: false; reason: string } }
    >;
    expect(winners.length, "exatamente 1 resgate do usuario vence (ok:true)").toBe(1);
    expect(
      winners[0].result.alreadyRedeemed,
      "o vencedor nao e repeticao (alreadyRedeemed=false)",
    ).toBe(false);
    expect(losers.length, "os N-1 restantes falham graciosamente").toBe(N - 1);
    for (const o of losers) {
      expect(
        o.result.reason,
        `perdedor deve ter reason='per_user_limit' (racer ${o.racerId}, order ${o.orderId})`,
      ).toBe("per_user_limit");
    }

    // --- ASSERT 2 (asserts#2): coupon_redemptions tem EXATAMENTE 1 linha p/ (couponId,userId);
    //     nenhuma 2a linha do mesmo usuario. E a do pedido VENCEDOR.
    const redemptions = await client.query<{ order_id: number }>(
      `SELECT order_id FROM "coupon_redemptions" WHERE coupon_id = $1 AND clerk_user_id = $2`,
      [couponId, userId],
    );
    expect(
      redemptions.rowCount,
      "exatamente 1 linha de redencao p/ (couponId,userId) (recontagem barra as demais)",
    ).toBe(1);
    const winnerOrderId = winners[0].orderId;
    expect(redemptions.rows[0].order_id, "a unica redencao e a do pedido vencedor").toBe(
      winnerOrderId,
    );

    // --- ASSERT 3 (asserts#3): coupons.redeemed_count == 1 ao final — reflete apenas o
    //     resgate aceito; sem incremento duplo (os perdedores abortam ANTES do increment
    //     global, sob o advisory lock).
    const after = await client.query<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(
      after.rows[0].redeemed_count,
      "redeemed_count == 1 (so a redencao do vencedor incrementou; sem incremento duplo)",
    ).toBe(1);
    expect(Number.isInteger(after.rows[0].redeemed_count)).toBe(true);

    // --- ASSERT 4 (asserts#4): cada linha de coupon_redemptions e unica por order_id
    //     (order_id @unique). Os N-1 pedidos PERDEDORES nao deixaram nenhuma linha (as N-1
    //     tentativas barradas deram rollback total — sem increment, sem insert parcial).
    const uniqueIdx = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_indexes
         WHERE tablename = 'coupon_redemptions' AND indexname = 'coupon_redemptions_order_id_key'`,
    );
    expect(
      Number(uniqueIdx.rows[0].count),
      "indice UNIQUE coupon_redemptions_order_id_key (order_id @unique) deve existir",
    ).toBe(1);

    const loserOrderIds = orderIds.filter((id) => id !== winnerOrderId);
    const loserRows = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions" WHERE order_id = ANY($1::int[])`,
      [loserOrderIds],
    );
    expect(
      Number(loserRows.rows[0].count),
      "nenhum pedido perdedor deixou linha de redencao (rollback total)",
    ).toBe(0);

    // Rede final do DB: CHECK redeemed_count>=0 nunca violado; teto logico (com
    // maxRedemptions NULL nao ha teto global, mas a recontagem por usuario manteve == 1).
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

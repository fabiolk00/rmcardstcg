import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.coupon.over-redeem (priority 32, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB CONCORRENCIA REAL que um cupom com maxRedemptions=1 e resgatado por
 * EXATAMENTE 1 dos N>=10 resgates concorrentes (cada um p/ um orderId DIFERENTE) —
 * over-redeem GLOBAL e impossivel — contra o Postgres efemero REAL exposto em
 * process.env.DATABASE_URL pelo runner.
 *
 * SEAM escolhida: redeemCoupon(tx, input) de lib/data/coupons.ts (L364) — a MESMA
 * funcao de PRODUCAO que o checkout chama. A anti-corrida do limite GLOBAL vive nela:
 *   const inc = await tx.coupon.updateMany({
 *     where: { id, redeemedCount: { lt: maxRedemptions } },   // CAS atomico
 *     data: { redeemedCount: { increment: 1 } },
 *   });
 *   if (inc.count === 0) return { ok:false, reason:'max_redemptions' };  // esgotado
 *   await tx.couponRedemption.create({ ... });                 // so se o CAS venceu
 * Sob N transacoes concorrentes, o lock de linha (row-level write lock) no UPDATE da
 * MESMA linha de coupons serializa os increments: o 1o a commitar leva redeemed_count
 * de 0->1; os demais, ao re-avaliar o predicado redeemed_count < 1, casam 0 linhas
 * (inc.count===0) e voltam { ok:false, reason:'max_redemptions' } SEM inserir. O seam
 * runner (_run-seam.ts, op "redeemCoupon" — INFRA de teste ja existente, VERDE nas
 * features irmas global-limit/per-user-limit) envelopa redeemCoupon num
 * prisma.$transaction EXATAMENTE como o checkout; em ok:false lanca RedeemAbort p/
 * forcar o ROLLBACK (espelha o checkout abortando a tx inteira), garantindo que nada
 * parcial persistiu (sem increment, sem linha em coupon_redemptions). Chamamos a funcao
 * de PRODUCAO direto, sem mock — a server action/checkout so monta o input apos validar
 * carrinho/preco (irrelevante p/ a invariante e inacessivel sem o middleware Proxy).
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE SEGURO (anti-fake-green):
 * disparamos N>=10 processos `tsx` SIMULTANEOS via `spawn` assincrono + Promise.all —
 * NAO `spawnSync` (que serializaria e tornaria o teste trivial). Cada racer e um
 * processo/transacao independente no MESMO Postgres, resgatando o MESMO cupom p/ um
 * orderId DISTINTO (entao a idempotencia por pedido — coupon_redemptions.order_id
 * UNIQUE — NUNCA curto-circuita: cada um e um pedido novo). perUserLimit=null isola a
 * causa: a UNICA coisa que impede 2+ redencoes e o CAS do limite GLOBAL. Se o produto
 * NAO fosse atomico (ex.: read-modify-write ingenuo: ler redeemed_count, comparar com
 * max em JS, depois UPDATE), dois racers leriam 0, ambos passariam o teto e
 * incrementariam -> redeemed_count==2 (over-redeem!) e 2 linhas em coupon_redemptions.
 * O teste exige redeemed_count==1, EXATAMENTE 1 ok:true e EXATAMENTE 1 linha de
 * redencao, entao qualquer corrida insegura o reprova.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso as MUTACOES rodam em processos `tsx` separados (tests/harness/estoque/_run-seam.ts),
 * herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Asserts canonicos da feature (4/4 provados via pg):
 *  A1 "Exatamente 1 resgate sucesso; os demais ok:false reason='max_redemptions'":
 *     dos N retornos do seam, exatamente 1 e ok:true/alreadyRedeemed:false; os N-1
 *     restantes sao ok:false/reason='max_redemptions' (nenhum P-error vazado).
 *  A2 "coupons.redeemed_count == 1 ao final (nunca 2)": coluna crua redeemed_count == 1.
 *  A3 "coupon_redemptions tem exatamente 1 linha; cada linha unica por order_id":
 *     1 linha p/ esse coupon_id; seu order_id e o do vencedor; nenhum outro order deixou linha.
 *  A4 "CHECK redeemed_count>=0 e <=maxRedemptions preservado durante toda a corrida":
 *     CHECK coupons_redeemed_count_chk existe e 0 violacoes de redeemed_count>=0; o teto
 *     logico redeemed_count<=max (1<=1) e respeitado pelo CAS (verificado via query).
 *
 * Invariante coberta: coupon-redeem-limits (limite global atomico via CAS; nenhuma
 * redencao alem do teto, mesmo sob corrida real no Postgres).
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
 * disputando o increment atomico do MESMO cupom). Resolve sempre (nunca rejeita) com
 * o resultado do seam ou um erro de processo, para que Promise.all colete TODOS os
 * desfechos.
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

const N = 12; // resgates concorrentes do MESMO cupom (>=10, exige o CAS atomico)
const MAX = 1; // teto global = 1 (over-redeem deve ser impossivel: so 1 vence)

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

test("chaos.coupon.over-redeem: N resgates concorrentes de cupom maxRedemptions=1, exatamente 1 vence (sem over-redeem)", async () => {
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
    const code = `OVR-${tag}`;

    // --- setup A: cupom PROPRIO percent, maxRedemptions=1, redeemedCount=0 (via PRODUCAO).
    //     perUserLimit=null ISOLA a causa: a UNICA barreira na corrida e o teto GLOBAL
    //     (o ramo per-user — advisory lock — nao participa). Partimos de redeemedCount=0
    //     (anti-trivial: nao perto do teto), entao a corrida disputa genuinamente o 0->1.
    const created = runSeamSync<CouponMutationResult>("createCoupon", {
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

    const preCount = await client.query<{ redeemed_count: number; max_redemptions: number }>(
      `SELECT redeemed_count, max_redemptions FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(preCount.rows[0].redeemed_count, "pre: redeemed_count=0").toBe(0);
    expect(preCount.rows[0].max_redemptions, "pre: max_redemptions=1").toBe(MAX);

    // --- setup B: N pedidos PROPRIOS DISTINTOS (order_id UNIQUE + FK p/ orders.id). Cada
    //     racer resgata p/ um orderId DIFERENTE => a idempotencia por pedido NUNCA
    //     curto-circuita: o que barra os perdedores e o teto GLOBAL, nao o order_id.
    const orderIds: number[] = [];
    for (let i = 0; i < N; i++) {
      orderIds.push(await insertOrder(client, `${tag}-${i}`, `user-${tag}-${i}`));
    }
    expect(new Set(orderIds).size, "todos os N pedidos sao distintos").toBe(N);

    // --- ACAO: dispara os N resgates SIMULTANEOS do MESMO cupom (orderIds distintos).
    //     Promise.all sobre processos spawn() assincronos => paralelismo REAL: todos os
    //     tsx correm ao mesmo tempo, cada um numa transacao independente, disputando o
    //     increment atomico (CAS WHERE redeemed_count < max) da MESMA linha de coupons.
    //     NAO ha serializacao artificial (spawnSync seria serial e trivial).
    const outcomes = await Promise.all(
      orderIds.map((orderId, i) =>
        redeemAsync(i, {
          couponId,
          orderId,
          userId: `user-${tag}-${i}`,
          discountCents: 1000,
          perUserLimit: null,
          maxRedemptions: MAX,
        }),
      ),
    );

    // Nenhum resgate pode vazar erro de processo/Prisma: cada um termina ou ok:true
    // (vencedor) ou ok:false/reason='max_redemptions' (perdedor recuperado pela funcao).
    const processFailures = outcomes.filter((o) => o.result === null);
    expect(
      processFailures,
      `nenhum resgate pode vazar erro (perdedor deve virar reason='max_redemptions'):\n${JSON.stringify(
        processFailures,
        null,
        2,
      )}`,
    ).toHaveLength(0);

    // --- ASSERT 1 (asserts#1): EXATAMENTE 1 resgate retorna sucesso; os N-1 restantes
    //     retornam ok:false reason='max_redemptions' (o CAS WHERE redeemed_count < max
    //     vence 1 vez so).
    const winners = outcomes.filter((o) => o.result?.ok === true) as Array<
      RedeemOutcome & { result: { ok: true; alreadyRedeemed: boolean } }
    >;
    const losers = outcomes.filter((o) => o.result?.ok === false) as Array<
      RedeemOutcome & { result: { ok: false; reason: string } }
    >;
    expect(winners.length, "exatamente 1 resgate vence (ok:true)").toBe(1);
    expect(
      winners[0].result.alreadyRedeemed,
      "o vencedor nao e repeticao (alreadyRedeemed=false)",
    ).toBe(false);
    expect(losers.length, "os N-1 restantes falham graciosamente").toBe(N - 1);
    for (const o of losers) {
      expect(
        o.result.reason,
        `perdedor deve ter reason='max_redemptions' (racer ${o.racerId}, order ${o.orderId})`,
      ).toBe("max_redemptions");
    }

    // --- ASSERT 2 (asserts#2): coupons.redeemed_count == 1 ao final — NUNCA 2, mesmo sob
    //     a corrida real no Postgres (o CAS atomico colapsa os N increments concorrentes
    //     em um unico 0->1).
    const after = await client.query<{ redeemed_count: number }>(
      `SELECT redeemed_count FROM "coupons" WHERE id = $1`,
      [couponId],
    );
    expect(after.rows[0].redeemed_count, "redeemed_count == 1 (sem over-redeem; jamais 2)").toBe(1);
    expect(Number.isInteger(after.rows[0].redeemed_count)).toBe(true);

    // --- ASSERT 3 (asserts#3): coupon_redemptions tem EXATAMENTE 1 linha p/ esse cupom; e a
    //     do pedido VENCEDOR; nenhum dos outros N-1 pedidos deixou linha (rollback total dos
    //     perdedores). Cada linha e unica por order_id (order_id @unique).
    const redemptions = await client.query<{ order_id: number }>(
      `SELECT order_id FROM "coupon_redemptions" WHERE coupon_id = $1`,
      [couponId],
    );
    expect(redemptions.rowCount, "exatamente 1 linha de redencao p/ esse cupom").toBe(1);
    const winnerOrderId = winners[0].orderId;
    expect(redemptions.rows[0].order_id, "a unica redencao e a do pedido vencedor").toBe(
      winnerOrderId,
    );

    // Os pedidos PERDEDORES nao deixaram nenhuma linha (as N-1 tentativas barradas deram
    // rollback total — sem increment, sem insert parcial).
    const loserOrderIds = orderIds.filter((id) => id !== winnerOrderId);
    const loserRows = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "coupon_redemptions" WHERE order_id = ANY($1::int[])`,
      [loserOrderIds],
    );
    expect(
      Number(loserRows.rows[0].count),
      "nenhum pedido perdedor deixou linha de redencao (rollback total)",
    ).toBe(0);

    // --- ASSERT 4 (asserts#4): CHECK redeemed_count>=0 nunca violado (rede de seguranca do
    //     DB); o teto logico redeemed_count<=max (1<=1) e respeitado pelo CAS durante toda
    //     a corrida.
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

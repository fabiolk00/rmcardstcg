import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.pix.expiry-vs-late-pay (priority 30, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB ADVERSALIDADE/CONCORRENCIA REAL que, quando um PIX pendente reservado
 * EXPIRA (estorno via pg_cron) e o webhook 'paid' chega ATRASADO, o sistema reconcilia
 * SEM baixar estoque ja estornado e SEM ressuscitar um pedido terminal — contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL.
 *
 * DUAS SEAMS de PRODUCAO, sem mock:
 *  1. EXPIRACAO via pg_cron: a funcao plpgsql REAL `expire_overdue_orders()`
 *     (prisma/migrations/20260615070000_expire_overdue_grace/migration.sql) — A MESMA
 *     que o job pg_cron `rmcards-expire-overdue` chama por nome. Ela cancela
 *     (payment_status='cancelled', shipping_status='cancelled') e ESTORNA a reserva
 *     (stock_reserved=false; products.reserved -= qty, stock fisico INTOCADO) de
 *     pedidos 'pending' com due_date vencido ha >60min e stock_reserved=true,
 *     idempotentemente. A spec a instala no banco efemero a partir do MESMO arquivo de
 *     migration (INFRA de teste — o harness so faz db push + CHECKs + seed, nao roda as
 *     migrations de pg_cron) e a dispara via `SELECT expire_overdue_orders()` pelo
 *     cliente `pg` sobre DATABASE_URL. NENHUM codigo de produto e tocado.
 *  2. WEBHOOK 'paid' ATRASADO: o CORACAO DO HANDLER de PRODUCAO do webhook do Asaas
 *     (app/api/webhooks/asaas/route.ts L136-156) via a op "processAsaasWebhook" do
 *     seam runner _run-seam.ts (ja existente, NAO precisei estender o runner): uma
 *     prisma.$transaction com recordWebhookEvent + guard de idempotencia +
 *     applyPaymentStatusTx (maquina de estado PAYMENT_TRANSITIONS + CAS de payment_status
 *     + conciliacao de estoque guardada por flags stockReserved/stockCommitted) +
 *     markWebhookEventProcessed. As funcoes sao de PRODUCAO (lib/data/webhookEvents +
 *     lib/data/orders); so o envelope HTTP fica de fora (irrelevante p/ a convergencia).
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE SEGURO (anti-fake-green):
 *  - Cenario A (expira ENTAO paid atrasado, sequencial): expire_overdue_orders() deixa o
 *    pedido cancelled + reserva estornada (stock_reserved=false). O 'paid' atrasado bate
 *    em cancelled->paid, ILEGAL (PAYMENT_TRANSITIONS.cancelled=[]) -> invalid_transition,
 *    SEM commit. Se a maquina deixasse cancelled virar paid, o reconcile de 'paid' acharia
 *    o pedido SEM reserva (estorno ja rodou) e o CAS WHERE stock_reserved=true retornaria
 *    0 linhas => commitStock NAO roda, mas o status viraria 'paid' => "pago sem baixa de
 *    estoque". A guarda de transicao barra isso ANTES do reconcile; o teste prova status
 *    final cancelled, stock fisico INALTERADO, sem audit da transicao barrada.
 *  - Cenario B (expiracao idempotente): rodar expire_overdue_orders() 2x NAO estorna em
 *    dobro (a 2a passada nao acha mais stock_reserved=true). reserved baixa EXATAMENTE 1x
 *    (jamais negativo); o paid atrasado segue barrado. Prova reserve-lifecycle-idempotent.
 *  - Cenario C (RAJADA CONCORRENTE REAL, N_TRIALS): a expiracao (SELECT
 *    expire_overdue_orders() via pg) e o webhook 'paid' (processo tsx spawnado) sao
 *    disparados SIMULTANEAMENTE via Promise.all (transacoes independentes no MESMO
 *    Postgres, SEM serializacao artificial), repetido N_TRIALS vezes com pedidos
 *    proprios distintos p/ exercitar as duas ordens de escalonamento. O row-lock + os CAS
 *    serializam; o resultado e SEMPRE coerente:
 *      - paid vence  -> status=paid,      stock=STOCK-QTY, reserved-=QTY (baixou 1x), committed=true.
 *      - expire vence-> status=cancelled, stock=STOCK,     reserved-=QTY (estornou 1x), committed=false;
 *                       o paid tardio vira invalid_transition (cancelled->paid).
 *    NUNCA: oversell (stock<STOCK-QTY), dupla baixa, reserva do alvo movida !=1x, reserva
 *    negativa, "pago sem baixa", ou o CHECK 0<=reserved<=stock violado. Se o produto
 *    permitisse qualquer um, o teste pega (assercoes via pg, sem mock).
 *
 * audit-same-tx: applyPaymentStatusTx audita (writeWebhookStockAuditLog) SO quando a
 * conciliacao reivindicou um efeito nesta tx (effect !== 'none'); a guarda de transicao
 * (invalid_transition) retorna ANTES do reconcile -> 0 audit. A expiracao via plpgsql e
 * fluxo de SISTEMA e nao grava audit_log (igual a cancelOrderAndReleaseStock de PRODUCAO).
 * Logo audit_log do pedido registra SOMENTE os efeitos LEGAIS de fato aplicados pelo
 * webhook; o paid barrado nunca audita; nenhuma dupla baixa/estorno.
 *
 * CAVEAT TECNICO (INFRA do harness, sem tocar produto): o Prisma gerado e ESM puro
 * (import.meta) e quebra se importado direto numa spec transpilada p/ CJS. Por isso a
 * mutacao do webhook roda num processo `tsx` separado (_run-seam.ts), herdando
 * DATABASE_URL; a expiracao (plpgsql) e disparada via SQL cru pelo cliente `pg`; e o
 * spec faz TODAS as assercoes via `pg` sobre DATABASE_URL.
 *
 * Invariantes cobertas: order-state-machine (cancelled->paid barrado; convergencia ao
 * terminal), reserve-lifecycle-idempotent (estorno guardado por flag + CAS, jamais 2x),
 * webhook-idempotent (efeito de estoque guardado por flags; nenhum ciclo roda 2x).
 * reserved-le-stock (CHECK 0<=reserved<=stock) como rede final.
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");
const EXPIRE_MIGRATION = path.resolve(
  process.cwd(),
  "prisma/migrations/20260615070000_expire_overdue_grace/migration.sql",
);

type SeamProduct = { id: string };
type PaymentRef = { id: string; valueCents: number | null };
type PaymentStatusUpdate =
  | { found: false }
  | { found: true; ok: false; reason: "payment_mismatch" | "value_mismatch" | "invalid_transition" }
  | {
      found: true;
      ok: true;
      changed: boolean;
      previousStatus: string;
      status: string;
      order: { paymentStatus: string };
    };
type WebhookOutcome = { duplicate: true } | { duplicate: false; result: PaymentStatusUpdate };

/** Desfecho de uma entrega concorrente, correlacionado a um rotulo. */
type DeliveryOutcome = {
  label: "paid";
  outcome: WebhookOutcome | null;
  error: string | null;
};

/** Chama uma op do seam via processo tsx SINCRONO (setup serial / entregas em ordem). */
function runSeamSync<T>(op: "createProduct" | "processAsaasWebhook", payload: unknown): T {
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
 * Entrega o webhook 'paid' via processo tsx ASSINCRONO. Resolve (nunca rejeita) quando o
 * processo termina — permitindo que a entrega corra em paralelo REAL (Promise.all) com a
 * expiracao plpgsql, cada uma uma transacao independente no MESMO Postgres.
 */
function deliverPaidWebhookAsync(payload: unknown): Promise<DeliveryOutcome> {
  return new Promise<DeliveryOutcome>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", SEAM_RUNNER, "processAsaasWebhook"], {
      env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) =>
      resolve({ label: "paid", outcome: null, error: `spawn error: ${e.message}` }),
    );
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          label: "paid",
          outcome: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as WebhookOutcome,
          error: null,
        });
        return;
      }
      if (errLine) {
        const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
        resolve({ label: "paid", outcome: null, error: `${e.name}: ${e.message}` });
        return;
      }
      resolve({
        label: "paid",
        outcome: null,
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

const STOCK = 10; // estoque fisico inicial
const RESERVED_OTHER = 3; // reserva de OUTRO pedido hipotetico (>0, anti-trivial): nunca deve ser tocada
const QTY = 2; // quantidade do pedido alvo (1 item)
const UNIT_CENTS = 4990; // preco unitario
const TOTAL_CENTS = QTY * UNIT_CENTS; // total do pedido = valor do evento paid (bate value-check)

const EVENT_PAID = "PAYMENT_CONFIRMED"; // -> 'paid' (EVENT_TO_STATUS de producao)
const DUE_MINUTES_AGO = 120; // vencido ha 2h (> janela de graca de 60min do expire)

const N_TRIALS = 14; // rajadas concorrentes p/ exercitar as duas ordens de chegada

/**
 * Cria um produto PROPRIO e um pedido PIX PROPRIO pendente JA reservado
 * (stockReserved=true, stockCommitted=false), com asaas_payment_id casado, total ==
 * valor do evento paid, e due_date VENCIDO ha >60min (elegivel ao expire). reserved do
 * produto = QTY (do pedido alvo) + RESERVED_OTHER (de uma ordem hipotetica; >0, prova
 * anti-trivial de que so a parte do pedido alvo se move). Retorna {productId, orderId,
 * paymentId, baseAuditOrder}.
 */
async function seedOverduePixOrder(
  client: Client,
  tag: string,
): Promise<{ productId: string; orderId: number; paymentId: string; baseAuditOrder: number }> {
  const created = runSeamSync<SeamProduct>("createProduct", {
    actor: { clerkUserId: null, email: null, role: null },
    input: {
      name: `Produto Harness PIX ${tag}`,
      category: "Booster Box",
      sku: `HARNESS-PIX-${tag}`,
      priceCents: UNIT_CENTS,
      discountPct: 0,
      stock: STOCK,
      badge: null,
      imageUrl: "/products/placeholder.svg",
      description: "fixture do harness para chaos.pix.expiry-vs-late-pay",
    },
  });
  const productId = created.id;

  // Forca stock=STOCK, reserved = QTY + RESERVED_OTHER (reserva ativa do pedido alvo +
  // de outra ordem hipotetica). reserved <= stock respeita o CHECK.
  const reserved = QTY + RESERVED_OTHER;
  await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
    STOCK,
    reserved,
    productId,
  ]);

  const paymentId = `pay_${tag}`;
  // due_date vencido ha DUE_MINUTES_AGO (> graca de 60min) torna o pedido elegivel ao
  // expire_overdue_orders(). created_at antigo nao e exigido pela funcao (ela filtra por
  // due_date), mas mantemos coerente.
  const orderIns = await client.query<{ id: number }>(
    `INSERT INTO "orders" (
       clerk_user_id, customer_name, customer_email, customer_phone,
       address_cep, address_street, address_city, address_state,
       subtotal_cents, discount_cents, shipping_cents, total_cents,
       payment_method, payment_status, shipping_status,
       asaas_payment_id, stock_reserved, stock_committed, due_date
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,$11,'pending','pending',$12,true,false,
       now() - ($13::text || ' minutes')::interval)
     RETURNING id`,
    [
      `harness-pix-${tag}`,
      "Harness PIX",
      `harness-pix-${tag}@example.com`,
      "(41) 90000-0000",
      "80000-000",
      "Rua Teste",
      "Curitiba",
      "PR",
      TOTAL_CENTS,
      TOTAL_CENTS,
      "PIX",
      paymentId,
      String(DUE_MINUTES_AGO),
    ],
  );
  const orderId = orderIns.rows[0].id;

  await client.query(
    `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`,
    [orderId, productId, `Produto Harness PIX ${tag}`, QTY, UNIT_CENTS],
  );

  const auditBefore = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE entity_type = 'order' AND entity_id = $1`,
    [String(orderId)],
  );
  return { productId, orderId, paymentId, baseAuditOrder: Number(auditBefore.rows[0].count) };
}

/** Monta o payload do seam para a entrega 'paid' (webhook atrasado). */
function paidPayloadFor(orderId: number, paymentId: string): unknown {
  return {
    orderId,
    status: "paid",
    eventId: `${paymentId}|${EVENT_PAID}`,
    type: EVENT_PAID,
    payment: { id: paymentId, valueCents: TOTAL_CENTS } satisfies PaymentRef,
    payload: { event: EVENT_PAID, payment: { id: paymentId, externalReference: String(orderId) } },
  };
}

/** Le o estado final (pedido + produto) para asserts de coerencia. */
async function readState(
  client: Client,
  orderId: number,
  productId: string,
): Promise<{
  payment_status: string;
  shipping_status: string;
  stock_reserved: boolean;
  stock_committed: boolean;
  stock: number;
  reserved: number;
}> {
  const ord = await client.query<{
    payment_status: string;
    shipping_status: string;
    stock_reserved: boolean;
    stock_committed: boolean;
  }>(
    `SELECT payment_status, shipping_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
    [orderId],
  );
  const prod = await client.query<{ stock: number; reserved: number }>(
    `SELECT stock, reserved FROM "products" WHERE id = $1`,
    [productId],
  );
  return {
    payment_status: ord.rows[0].payment_status,
    shipping_status: ord.rows[0].shipping_status,
    stock_reserved: ord.rows[0].stock_reserved,
    stock_committed: ord.rows[0].stock_committed,
    stock: prod.rows[0].stock,
    reserved: prod.rows[0].reserved,
  };
}

/** Conta as linhas de audit do pedido (so as transicoes legais aplicadas sao gravadas). */
async function auditCountForOrder(client: Client, orderId: number): Promise<number> {
  const r = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE entity_type = 'order' AND entity_id = $1`,
    [String(orderId)],
  );
  return Number(r.rows[0].count);
}

test("chaos.pix.expiry-vs-late-pay: PIX expira (pg_cron) e paid atrasado reconcilia sem baixar estoque ja estornado", async () => {
  test.setTimeout(300_000); // muitos processos tsx sob Windows

  const client = makeClient();
  await client.connect();
  try {
    // INFRA de teste: instala a funcao plpgsql REAL do pg_cron (expire_overdue_orders)
    // no banco efemero. O harness so faz db push + CHECKs + seed; as migrations de
    // pg_cron nao rodam. CREATE OR REPLACE => idempotente. Esta e a MESMA funcao que o
    // job pg_cron chama por nome em producao; nenhum codigo de produto e tocado.
    await client.query(readFileSync(EXPIRE_MIGRATION, "utf8"));

    const otherReserved = RESERVED_OTHER; // reserva de outra ordem; INVARIANTE em todos os cenarios

    // ===================================================================
    // CENARIO A: PIX expira (pg_cron) ENTAO chega o 'paid' ATRASADO (sequencial).
    // expire_overdue_orders() cancela + estorna a reserva (stock_reserved=false). O 'paid'
    // tardio -> cancelled->paid ILEGAL (PAYMENT_TRANSITIONS.cancelled=[]) ->
    // invalid_transition, SEM commit, SEM audit. Final: cancelled, reserva do alvo
    // estornada, estoque fisico INALTERADO (nunca "pago sem baixa").
    // ===================================================================
    {
      const tag = `a-${randomUUID().slice(0, 8)}`;
      const { productId, orderId, paymentId, baseAuditOrder } = await seedOverduePixOrder(
        client,
        tag,
      );

      // pg_cron: expira o pendente vencido. v_expired conta os cancelados-com-estorno.
      const expired = await client.query<{ expire_overdue_orders: number }>(
        `SELECT expire_overdue_orders()`,
      );
      expect(
        Number(expired.rows[0].expire_overdue_orders),
        "A: expire_overdue_orders cancelou+estornou >=1 pedido vencido (inclui o alvo)",
      ).toBeGreaterThanOrEqual(1);

      // Pos-expiracao: cancelled, reserva do alvo estornada, estoque fisico intacto.
      const afterExpire = await readState(client, orderId, productId);
      expect(afterExpire.payment_status, "A: expirado -> payment_status cancelled").toBe(
        "cancelled",
      );
      expect(afterExpire.shipping_status, "A: expirado -> shipping_status cancelled").toBe(
        "cancelled",
      );
      expect(
        afterExpire.stock_reserved,
        "A: expirado -> stock_reserved=false (reserva estornada)",
      ).toBe(false);
      expect(afterExpire.stock_committed, "A: expirado -> stock_committed segue false").toBe(false);
      expect(
        afterExpire.stock,
        "A: expirado nao toca estoque fisico (release so estorna reserva)",
      ).toBe(STOCK);
      expect(
        afterExpire.reserved,
        "A: reserva do pedido alvo estornada 1x; a do outro pedido intacta",
      ).toBe(otherReserved);

      // Webhook 'paid' ATRASADO: cancelled->paid ILEGAL -> invalid_transition (nunca aplicado).
      const lateePaid = runSeamSync<WebhookOutcome>(
        "processAsaasWebhook",
        paidPayloadFor(orderId, paymentId),
      );
      expect(lateePaid.duplicate, "A: paid atrasado nao e duplicate (event_id novo)").toBe(false);
      if (lateePaid.duplicate) throw new Error("A: paid atrasado inesperadamente duplicate");
      expect(lateePaid.result.found, "A: pedido encontrado pelo webhook").toBe(true);
      if (!lateePaid.result.found) throw new Error("A: paid atrasado nao found");
      expect(lateePaid.result.ok, "A: paid atrasado rejeitado (ok:false)").toBe(false);
      if (lateePaid.result.ok) throw new Error("A: paid atrasado inesperadamente ok");
      expect(
        lateePaid.result.reason,
        "A: reason invalid_transition (cancelled->paid barrado, nao mismatch)",
      ).toBe("invalid_transition");

      // Estado final: NADA mudou em relacao ao pos-expiracao (paid barrado, sem efeito).
      const finalSt = await readState(client, orderId, productId);
      expect(finalSt.payment_status, "A: terminal cancelled (paid atrasado barrado)").toBe(
        "cancelled",
      );
      expect(
        finalSt.stock,
        "A: estoque fisico inalterado (paid barrado => commitStock NAO roda; CAS stock_reserved=true acharia 0)",
      ).toBe(STOCK);
      expect(finalSt.reserved, "A: reserva do alvo segue estornada 1x; a do outro intacta").toBe(
        otherReserved,
      );
      expect(
        finalSt.stock_reserved,
        "A: stock_reserved false (estorno) e o paid nao reservou",
      ).toBe(false);
      expect(finalSt.stock_committed, "A: stock_committed false (paid barrado, sem commit)").toBe(
        false,
      );

      // audit: a expiracao plpgsql NAO grava audit_log (fluxo de sistema) e o paid barrado
      // retorna ANTES do reconcile -> 0 audit. delta == 0 p/ o pedido.
      const delta = (await auditCountForOrder(client, orderId)) - baseAuditOrder;
      expect(
        delta,
        "A: nenhuma transicao legal aplicada via webhook (paid barrado) => 0 audit; expire e sistema (sem audit)",
      ).toBe(0);
      // Reforco: 0 linhas com after.paymentStatus='paid' p/ este pedido (paid nunca aplicado).
      const paidAudit = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "audit_log"
           WHERE entity_type = 'order' AND entity_id = $1
             AND action = 'order.payment_status_update'
             AND (after->>'paymentStatus') = 'paid'`,
        [String(orderId)],
      );
      expect(Number(paidAudit.rows[0].count), "A: nenhum audit registra paid (barrado)").toBe(0);
    }

    // ===================================================================
    // CENARIO B: EXPIRACAO IDEMPOTENTE + paid atrasado. Roda expire_overdue_orders() 2x:
    // a 2a passada NAO acha mais stock_reserved=true => NAO estorna em dobro (reserved
    // baixa EXATAMENTE 1x, jamais negativo). O paid atrasado segue barrado. Prova
    // reserve-lifecycle-idempotent sob repeticao do estorno.
    // ===================================================================
    {
      const tag = `b-${randomUUID().slice(0, 8)}`;
      const { productId, orderId, paymentId, baseAuditOrder } = await seedOverduePixOrder(
        client,
        tag,
      );

      await client.query(`SELECT expire_overdue_orders()`);
      const afterFirst = await readState(client, orderId, productId);
      expect(afterFirst.payment_status, "B: 1a expiracao -> cancelled").toBe("cancelled");
      expect(afterFirst.reserved, "B: 1a expiracao estorna a reserva do alvo 1x").toBe(
        otherReserved,
      );
      expect(afterFirst.stock_reserved, "B: 1a expiracao -> stock_reserved false").toBe(false);

      // 2a passada do cron: idempotente. Pedido ja nao esta pending-reservado => nao estorna.
      await client.query(`SELECT expire_overdue_orders()`);
      const afterSecond = await readState(client, orderId, productId);
      expect(
        afterSecond.reserved,
        "B: 2a expiracao e no-op (reserved NAO baixa em dobro; jamais negativo)",
      ).toBe(otherReserved);
      expect(afterSecond.stock, "B: estoque fisico segue intacto apos 2 expiracoes").toBe(STOCK);
      expect(afterSecond.payment_status, "B: segue cancelled (idempotente)").toBe("cancelled");

      // paid atrasado: barrado (cancelled->paid).
      const lateePaid = runSeamSync<WebhookOutcome>(
        "processAsaasWebhook",
        paidPayloadFor(orderId, paymentId),
      );
      expect(lateePaid.duplicate, "B: paid atrasado nao e duplicate").toBe(false);
      if (lateePaid.duplicate) throw new Error("B: paid atrasado inesperadamente duplicate");
      expect(lateePaid.result.found && !lateePaid.result.ok, "B: paid atrasado rejeitado").toBe(
        true,
      );
      if (!lateePaid.result.found || lateePaid.result.ok) {
        throw new Error("B: paid atrasado deveria ser found && !ok");
      }
      expect(lateePaid.result.reason, "B: invalid_transition (cancelled->paid)").toBe(
        "invalid_transition",
      );

      const finalSt = await readState(client, orderId, productId);
      expect(finalSt.payment_status, "B: terminal cancelled").toBe("cancelled");
      expect(finalSt.stock, "B: estoque fisico inalterado").toBe(STOCK);
      expect(finalSt.reserved, "B: reserva do alvo estornada exatamente 1x").toBe(otherReserved);
      expect(finalSt.stock_committed, "B: stock_committed false").toBe(false);

      const delta = (await auditCountForOrder(client, orderId)) - baseAuditOrder;
      expect(delta, "B: 0 audit (expire e sistema; paid barrado nao audita)").toBe(0);
    }

    // ===================================================================
    // CENARIO C: RAJADA CONCORRENTE REAL. expire_overdue_orders() (via pg) e o webhook
    // 'paid' (processo tsx spawnado) disparados SIMULTANEAMENTE (Promise.all; transacoes
    // independentes no MESMO PG, SEM serializacao artificial), repetido N_TRIALS vezes
    // com pedidos proprios distintos. O row-lock + os CAS serializam; o terminal e SEMPRE
    // coerente, SEM oversell/dupla baixa/reserva negativa/"pago sem baixa". Coletamos a
    // distribuicao dos terminais p/ provar que AMBAS as corridas (paid-vence e expire-vence)
    // ocorrem na pratica.
    // ===================================================================
    const terminals = { paid: 0, cancelled: 0 };
    for (let trial = 0; trial < N_TRIALS; trial++) {
      const tag = `c${trial}-${randomUUID().slice(0, 8)}`;
      const { productId, orderId, paymentId, baseAuditOrder } = await seedOverduePixOrder(
        client,
        tag,
      );

      // DISPARO SIMULTANEO: expire (plpgsql via pg) x paid (webhook via tsx). Promise.all
      // => paralelismo REAL no mesmo Postgres, sem ordem garantida E sem serializacao
      // artificial. CAVEAT estrutural: a query `pg` roda no MESMO processo (rapida),
      // enquanto o webhook e um processo `tsx` recem-spawnado (startup pesado ~1-2s). Sem
      // contramedida, o expire SEMPRE pegaria o row-lock primeiro e venceria 100% das
      // vezes — o ramo "paid vence sob corrida" nunca seria exercitado (fake-green
      // disfarcado). Para uma corrida HONESTA que exercita AMBAS as ordens, adicionamos
      // um JITTER aleatorio (Math.random e permitido DENTRO da spec — roda em Node
      // normal) ao lado do expire: as vezes o expire dispara ANTES, as vezes DEPOIS de o
      // webhook ja ter conectado/reivindicado o row-lock. Em nenhum caso serializamos: as
      // duas tx competem de verdade pelo MESMO row; quem chega primeiro ao lock vence e a
      // outra, ao reler sob o lock, vira no-op/barrada. O jitter so embaralha a CHEGADA.
      const expireJitterMs = Math.floor(Math.random() * 1500);
      const paidPromise = deliverPaidWebhookAsync(paidPayloadFor(orderId, paymentId));
      const expirePromise = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
        setTimeout(() => {
          client
            .query(`SELECT expire_overdue_orders()`)
            .then(() => resolve({ ok: true as const }))
            .catch((e: unknown) =>
              resolve({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
            );
        }, expireJitterMs);
      });

      const [expireRes, paidRes] = await Promise.all([expirePromise, paidPromise]);

      // Nenhuma das duas pode falhar de forma inesperada (erro de infra != desfecho de dominio).
      expect(
        expireRes.ok,
        `C[${trial}]: expire_overdue_orders nao pode falhar como query: ${
          "error" in expireRes ? expireRes.error : ""
        }`,
      ).toBe(true);
      expect(
        paidRes.outcome,
        `C[${trial}]: a entrega 'paid' nao pode falhar como processo:\n${JSON.stringify(
          paidRes,
          null,
          2,
        )}`,
      ).not.toBeNull();

      const st = await readState(client, orderId, productId);

      // Convergencia: o terminal e SEMPRE 'paid' ou 'cancelled' (nunca 'pending').
      expect(["paid", "cancelled"]).toContain(st.payment_status);
      if (st.payment_status === "paid") terminals.paid++;
      else terminals.cancelled++;

      // ----- INVARIANTES QUE VALEM EM TODOS OS INTERLEAVINGS -----
      // (a) a reserva do PEDIDO ALVO foi resolvida EXATAMENTE 1x (de QTY+otherReserved p/
      //     otherReserved), seja por commit (paid venceu) ou por release (expire venceu);
      //     a reserva do OUTRO pedido hipotetico fica intacta. Nunca movida !=1x.
      expect(
        st.reserved,
        `C[${trial}]: reserva do alvo resolvida EXATAMENTE 1x (commit OU release); a do outro intacta`,
      ).toBe(otherReserved);

      // (b) stock fisico coerente: STOCK-QTY SSE paid venceu (commit baixou 1x); STOCK SSE
      //     expire venceu (release nao toca estoque fisico). NUNCA abaixo de STOCK-QTY
      //     (sem dupla baixa/oversell) nem acima de STOCK (sem reposicao indevida).
      expect(
        [STOCK, STOCK - QTY],
        `C[${trial}]: stock fisico coerente (STOCK ou STOCK-QTY); jamais oversell/dupla`,
      ).toContain(st.stock);

      // (c) casamento ESTRITO status<->efeito (este cenario, ao contrario do
      //     out-of-order, e mutuamente exclusivo: o expire so age em pending-reservado, o
      //     paid so reivindica pending-reservado; o vencedor do row-lock leva tudo):
      //       paid      => committed=true,  reserved-=QTY, stock=STOCK-QTY, stock_reserved=false.
      //       cancelled => committed=false,                stock=STOCK,     stock_reserved=false.
      //     Isto prova exatamente o que a feature pede: NUNCA "pago sem baixa" (paid =>
      //     stock baixou) e NUNCA baixa de estoque ja estornado (cancelled => stock intacto).
      if (st.payment_status === "paid") {
        expect(st.stock_committed, `C[${trial}]: paid => committed=true`).toBe(true);
        expect(
          st.stock,
          `C[${trial}]: paid => stock baixou 1x (STOCK-QTY); nunca pago sem baixa`,
        ).toBe(STOCK - QTY);
      } else {
        expect(st.stock_committed, `C[${trial}]: cancelled => committed=false`).toBe(false);
        expect(
          st.stock,
          `C[${trial}]: cancelled => estoque fisico intacto (STOCK); paid atrasado nao baixou o ja estornado`,
        ).toBe(STOCK);
      }

      // (d) stockReserved sempre false ao final (commit ou release encerram a reserva do alvo).
      expect(st.stock_reserved, `C[${trial}]: stockReserved encerrado (false) ao final`).toBe(
        false,
      );

      // audit: 0 (expire venceu: paid barrado/no efeito; expire e sistema sem audit) OU 1
      // (paid venceu: commit auditado 1x na mesma tx). NUNCA >1 (nenhum efeito 2x).
      const delta = (await auditCountForOrder(client, orderId)) - baseAuditOrder;
      if (st.payment_status === "paid") {
        expect(delta, `C[${trial}]: paid venceu => 1 audit do commit (na mesma tx)`).toBe(1);
      } else {
        expect(
          delta,
          `C[${trial}]: expire venceu => 0 audit (sistema; paid atrasado barrado nao audita)`,
        ).toBe(0);
      }

      // Nenhum audit de transicao BARRADA/no-op: cada linha de audit corresponde a uma
      // transicao que de fato mudou o estado (before != after).
      const noopAudit = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "audit_log"
           WHERE entity_type = 'order' AND entity_id = $1
             AND action = 'order.payment_status_update'
             AND (before->>'paymentStatus') = (after->>'paymentStatus')`,
        [String(orderId)],
      );
      expect(
        Number(noopAudit.rows[0].count),
        `C[${trial}]: nenhum audit de no-op/barrada (before==after)`,
      ).toBe(0);
    }

    // ===================================================================
    // REDE FINAL (apos todos os cenarios + N_TRIALS rajadas): o CHECK 0<=reserved<=stock
    // existe e NUNCA foi violado em nenhum ponto da corrida — prova anti-oversell e
    // reserva-nao-negativa sob concorrencia real (se algum commit baixasse 2x, ou um
    // release/expire estornasse alem do reservado, o CHECK abortaria a tx e/ou deixaria
    // linha violada).
    // ===================================================================
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(
      Number(violations.rows[0].count),
      "nenhuma linha viola 0<=reserved<=stock apos toda a adversalidade",
    ).toBe(0);

    // Diagnostico (registrado): a distribuicao de terminais mostra que a corrida foi REAL.
    expect(
      terminals.paid + terminals.cancelled,
      "todos os N_TRIALS convergiram a um terminal coerente",
    ).toBe(N_TRIALS);
    console.info(
      `[chaos.pix.expiry-vs-late-pay] distribuicao de terminais sob rajada (expire x paid atrasado): ${JSON.stringify(
        terminals,
      )} (de ${N_TRIALS} trials)`,
    );
  } finally {
    await client.end();
  }
});

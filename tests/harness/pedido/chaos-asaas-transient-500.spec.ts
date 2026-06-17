import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.asaas.transient-500 (priority 29, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB ADVERSALIDADE REAL (falha transitoria + redelivery concorrente) que um
 * webhook de pagamento do Asaas cuja PRIMEIRA entrega falha com 500 ANTES de marcar
 * processed_at, quando reentregue enquanto processed_at IS NULL, aplica o efeito de
 * estoque EXACTLY-ONCE — contra o Postgres efemero REAL exposto em
 * process.env.DATABASE_URL pelo runner.
 *
 * SEAM escolhida: o CORACAO DO HANDLER de PRODUCAO (app/api/webhooks/asaas/route.ts
 * L136-156). O route roda numa UNICA prisma.$transaction:
 *   recordWebhookEvent  (INSERT "webhook_events" ON CONFLICT DO NOTHING via skipDuplicates)
 *   guard de idempotencia (se !firstTime && isWebhookEventProcessed => no-op duplicate)
 *   applyPaymentStatusTx (CAS de payment_status + conciliacao de estoque por flags:
 *                         ramo 'paid' => commitStock, auditado na MESMA tx)
 *   markWebhookEventProcessed (processed_at = now())
 * Se QUALQUER passo entre record e mark-processed lancar (timeout de DB, queda de
 * conexao, erro transitorio), a transacao inteira faz ROLLBACK e o catch do route
 * responde 500 (NextResponse status 500) p/ o Asaas reenfileirar. Como ledger + efeito
 * + mark-processed sao a MESMA tx, o rollback DESFAZ tambem o recordWebhookEvent: nao
 * sobra linha em webhook_events com efeito aplicado (processed_at IS NULL), e o estoque
 * NAO baixa. Reprocessar e seguro (semantica at-least-once correta, H3 do route).
 *
 * Duas ops do seam runner _run-seam.ts, ambas chamando as MESMAS 4 funcoes de PRODUCAO
 * (lib/data/webhookEvents + lib/data/orders), SEM mock:
 *   - processAsaasWebhookFailing: identica ao route porem com um throw injetado APOS o
 *     efeito e ANTES do mark-processed -> forca o rollback (modela o 500 transitorio).
 *     O ponto de injecao espelha "qualquer erro dentro do $transaction antes do
 *     mark-processed", que o route ja trata como 500. Devolve { failed:true }.
 *   - processAsaasWebhook: o caminho feliz (record + guard + efeito + mark-processed na
 *     mesma tx). Devolve { duplicate } e, quando aplicou, o PaymentStatusUpdate.
 * So o envelope HTTP (parse/token/teto-de-payload/email) fica de fora — irrelevante p/
 * a idempotencia de estoque/ledger e inacessivel sem subir o middleware Proxy que
 * protege /admin e os internals; o miolo idempotente e identico. O eventId usa o MESMO
 * formato do route (asaasEventId = `${paymentId}|${event}`).
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE EXACTLY-ONCE (anti-fake-green):
 *  - FASE 1 (falha): N>=4 entregas em RAJADA CONCORRENTE (spawn assincrono + Promise.all)
 *    do MESMO (provider,eventId), TODAS dando 500 transitorio. Cada uma roda sua propria
 *    transacao no MESMO Postgres e ROLLBACK. Se o produto NAO fizesse record+efeito+mark
 *    na MESMA tx (ex.: gravasse o ledger fora da tx do efeito, ou marcasse processed_at
 *    antes do efeito), uma falha deixaria processed_at setado SEM baixar estoque (efeito
 *    perdido) OU baixaria estoque sem poder reprocessar. Asserimos que apos as N falhas:
 *    NAO ha linha persistida em webhook_events p/ o evento (rollback desfez o record), e
 *    o estoque/flags do pedido estao INTOCADOS (sem baixa parcial).
 *  - FASE 2 (retry): apos as falhas, uma RAJADA de M>=4 redeliveries CONCORRENTES do
 *    MESMO evento (caminho feliz) + 1 redelivery SEQUENCIAL tardia. Se o produto nao
 *    fosse idempotente, varias baixariam estoque (stock cairia 2x,4x...) e/ou criariam
 *    linhas duplicadas no ledger. Asserimos: EXATAMENTE 1 entrega aplica (changed); as
 *    demais sao no-op (duplicate/changed:false pelo CAS das flags); 1 unica linha em
 *    webhook_events; processed_at NULL->timestamp 1x; stock baixou 1x (S->S-QTY,
 *    reserved R->R-QTY); audit do commit 1x na MESMA tx. NAO ha serializacao artificial.
 *
 * Invariantes cobertas: webhook-idempotent (UNIQUE (provider,eventId) + processed_at;
 * a entrega que deu 500 deixou processed_at NULL permitindo retry seguro; reprocessar
 * apos sucesso e no-op) e audit-same-tx (o efeito e auditado 1x na MESMA tx, sem
 * duplicar; CHECK 0<=reserved<=stock valido). Tambem prova reserve-lifecycle-idempotent
 * implicitamente (commit guardado por flags do pedido).
 *
 * CAVEAT TECNICO (INFRA do harness, sem tocar produto): o Prisma gerado e ESM puro
 * (import.meta) e quebra se importado direto numa spec transpilada p/ CJS. Por isso as
 * mutacoes rodam em processos `tsx` separados (_run-seam.ts), herdando DATABASE_URL; o
 * spec faz TODAS as assercoes via `pg`.
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type SeamProduct = { id: string };
type PaymentRef = { id: string; valueCents: number | null };
type PaymentStatusUpdate =
  | { found: false }
  | { found: true; ok: false; reason: string }
  | { found: true; ok: true; changed: boolean; previousStatus: string; status: string };
type WebhookOutcome = { duplicate: true } | { duplicate: false; result: PaymentStatusUpdate };
type FailingOutcome = { duplicate: true } | { failed: true };

/** Desfecho de uma das entregas (correlaciona resultado/erro a um id de entrega). */
type DeliveryOutcome<T> = {
  deliveryId: number;
  outcome: T | null;
  error: string | null;
};

/** Cria produto via processo tsx SINCRONO (setup serial). */
function runSeamSync<T>(op: "createProduct", payload: unknown): T {
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
 * Entrega o webhook via processo tsx ASSINCRONO p/ a `op` dada. RETORNA uma Promise que
 * so resolve quando o processo termina — permitindo que N entregas rodem em paralelo
 * REAL via Promise.all (cada uma e um processo/transacao independente no MESMO Postgres,
 * processando o MESMO (provider,eventId)). Resolve sempre (nunca rejeita) com o outcome
 * do seam ou um erro de processo, p/ Promise.all coletar TODOS os desfechos.
 */
function deliverAsync<T>(
  op: "processAsaasWebhook" | "processAsaasWebhookFailing",
  deliveryId: number,
  payload: unknown,
): Promise<DeliveryOutcome<T>> {
  return new Promise<DeliveryOutcome<T>>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
      env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) =>
      resolve({ deliveryId, outcome: null, error: `spawn error: ${e.message}` }),
    );
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          deliveryId,
          outcome: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as T,
          error: null,
        });
        return;
      }
      if (errLine) {
        const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
        resolve({ deliveryId, outcome: null, error: `${e.name}: ${e.message}` });
        return;
      }
      resolve({
        deliveryId,
        outcome: null,
        error: `seam runner sem resultado (status ${status}):\n${stdout}\n${stderr}`,
      });
    });
  });
}

/** Entrega SINCRONA (reenvio tardio sequencial do Asaas), caminho feliz. */
function deliverSync(payload: unknown): WebhookOutcome {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, "processAsaasWebhook"], {
    encoding: "utf8",
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32",
  });
  const out = `${r.stdout ?? ""}`;
  const okLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
  const errLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
  if (errLine) {
    const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
    throw new Error(`${e.name}: ${e.message}`);
  }
  if (!okLine) throw new Error(`seam runner sem resultado:\n${out}\n${r.stderr ?? ""}`);
  return JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as WebhookOutcome;
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const STOCK = 10; // estoque fisico inicial
const RESERVED = 3; // unidades reservadas pelo checkout (>= QTY); reserved>0 nao-trivial
const QTY = 2; // quantidade do pedido (1 item)
const UNIT_CENTS = 4990; // preco unitario
const TOTAL_CENTS = QTY * UNIT_CENTS; // total do pedido = valor do evento (bate value-check)
const N_FAIL = 4; // entregas que dao 500 transitorio em rajada concorrente
const M_RETRY = 4; // redeliveries do caminho feliz em rajada concorrente
// total de entregas = N_FAIL (500) + M_RETRY (retry concorrente) + 1 (reenvio tardio).

test("chaos.asaas.transient-500: 500 transitorio + redelivery (processed_at NULL) aplica efeito 1x", async () => {
  // ~9 processos tsx (cada um sobe um Prisma) sob Windows: folga ampla.
  test.setTimeout(240_000);

  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup A: cria produto PROPRIO (createProduct de PRODUCAO), depois forca
    //     stock=STOCK, reserved=RESERVED (>0, nao-trivial). reserved e gerido pelo ciclo
    //     de reserva; pre-posicionar via SQL e a forma honesta de montar a pre-condicao.
    const created = runSeamSync<SeamProduct>("createProduct", {
      actor,
      input: {
        name: `Produto Harness Asaas500 ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-A500-${tag}`,
        priceCents: UNIT_CENTS,
        discountPct: 0,
        stock: STOCK,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para chaos.asaas.transient-500",
      },
    });
    const productId = created.id;

    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK,
      RESERVED,
      productId,
    ]);
    const pre = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    expect(pre.rows[0].stock, "setup deve deixar stock=STOCK").toBe(STOCK);
    expect(pre.rows[0].reserved, "setup deve deixar reserved=RESERVED (>0)").toBe(RESERVED);

    // --- setup B: cria pedido PROPRIO pendente, JA reservado (stockReserved=true,
    //     stockCommitted=false), com asaasPaymentId casado (anti-replay) e total ==
    //     valor do evento. 1 item de QTY unidades. (snake_case = colunas do DB.)
    const paymentId = `pay_${tag}`;
    const orderIns = await client.query<{ id: number }>(
      `INSERT INTO "orders" (
         clerk_user_id, customer_name, customer_email, customer_phone,
         address_cep, address_street, address_city, address_state,
         subtotal_cents, total_cents, payment_method, payment_status,
         asaas_payment_id, stock_reserved, stock_committed
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        `harness-a500-${tag}`,
        "Harness Asaas500",
        `harness-a500-${tag}@example.com`,
        "(41) 90000-0000",
        "80000-000",
        "Rua Teste",
        "Curitiba",
        "PR",
        TOTAL_CENTS,
        TOTAL_CENTS,
        "PIX",
        "pending",
        paymentId,
        true,
        false,
      ],
    );
    expect(orderIns.rowCount).toBe(1);
    const orderId = orderIns.rows[0].id;

    // order_items.id e uuid gerado pela app (Prisma @default(uuid)), nao pelo DB.
    await client.query(
      `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`,
      [orderId, productId, `Produto Harness Asaas500 ${tag}`, QTY, UNIT_CENTS],
    );

    // Baseline de audit_log (global e do pedido) ANTES das entregas — p/ provar que o
    // efeito e auditado 1x e a reentrega NAO duplica (delta == 1).
    const auditBeforeOrder = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE entity_type = 'order' AND entity_id = $1`,
      [String(orderId)],
    );
    const auditBeforeGlobal = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const baseAuditOrder = Number(auditBeforeOrder.rows[0].count);
    const baseAuditGlobal = Number(auditBeforeGlobal.rows[0].count);

    // event_id ESTAVEL no MESMO formato do route (asaasEventId): `${paymentId}|${event}`.
    const event = "PAYMENT_CONFIRMED";
    const eventId = `${paymentId}|${event}`;
    const payment: PaymentRef = { id: paymentId, valueCents: TOTAL_CENTS };
    const payloadFor = (): unknown => ({
      orderId,
      status: "paid",
      eventId, // MESMO (provider,eventId) em TODAS as entregas (falhas e retries)
      type: event,
      payment,
      payload: { event, payment: { id: paymentId, externalReference: String(orderId) } },
    });

    // ===================================================================
    // FASE 1 — 500 TRANSITORIO: N entregas CONCORRENTES do MESMO evento, TODAS falham
    // (throw apos o efeito, antes do mark-processed) -> rollback total de cada uma.
    // ===================================================================
    const fails = await Promise.all(
      Array.from({ length: N_FAIL }, (_unused, i) =>
        deliverAsync<FailingOutcome>("processAsaasWebhookFailing", i, payloadFor()),
      ),
    );
    const failProcessErrors = fails.filter((f) => f.outcome === null);
    expect(
      failProcessErrors,
      `nenhuma entrega que deu 500 pode falhar como PROCESSO (erro de infra != 500 de dominio):\n${JSON.stringify(
        failProcessErrors,
        null,
        2,
      )}`,
    ).toHaveLength(0);
    // Cada entrega da FASE 1 sai como { failed:true } (rollback do 500) ou, sob corrida,
    // { duplicate:true } caso outra ja tivesse marcado processed_at — mas como TODAS
    // falham antes do mark-processed, NENHUMA pode marcar; logo todas devem ser failed.
    const failedDeliveries = fails.filter(
      (f) => f.outcome !== null && "failed" in (f.outcome as object),
    );
    expect(
      failedDeliveries.length,
      "todas as N entregas da fase 1 fazem rollback (failed:true); nenhuma marca processed_at",
    ).toBe(N_FAIL);

    // ASSERT FASE 1: o rollback do 500 desfez o recordWebhookEvent — NAO ha linha
    // persistida em webhook_events p/ o evento (record + efeito eram a MESMA tx). Isto e
    // a pre-condicao de retry seguro: processed_at IS NULL (aqui, nem linha existe).
    const ledgerAfterFail = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "webhook_events"
         WHERE provider = 'asaas' AND event_id = $1`,
      [eventId],
    );
    expect(
      Number(ledgerAfterFail.rows[0].count),
      "500 transitorio fez rollback do ledger: 0 linhas em webhook_events (retry seguro, processed_at IS NULL)",
    ).toBe(0);

    // ASSERT FASE 1: o efeito de estoque NAO foi aplicado (rollback). stock/reserved e as
    // flags do pedido seguem INTOCADOS — sem baixa parcial nem perda de efeito.
    const prodAfterFail = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(prodAfterFail.rows[0].stock, "estoque intocado apos o 500 (sem baixa)").toBe(STOCK);
    expect(prodAfterFail.rows[0].reserved, "reserved intocado apos o 500").toBe(RESERVED);
    const orderAfterFail = await client.query<{
      stock_reserved: boolean;
      stock_committed: boolean;
      payment_status: string;
    }>(`SELECT stock_reserved, stock_committed, payment_status FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(
      orderAfterFail.rows[0].stock_reserved,
      "stockReserved segue true (efeito nao aplicado)",
    ).toBe(true);
    expect(
      orderAfterFail.rows[0].stock_committed,
      "stockCommitted segue false (efeito nao aplicado)",
    ).toBe(false);
    expect(
      orderAfterFail.rows[0].payment_status,
      "payment_status segue pending (CAS nao commitou)",
    ).toBe("pending");
    // Nenhuma auditoria orfa pode ter sobrado do rollback.
    const auditAfterFail = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE entity_type = 'order' AND entity_id = $1`,
      [String(orderId)],
    );
    expect(
      Number(auditAfterFail.rows[0].count) - baseAuditOrder,
      "rollback do 500 nao deixa audit orfao (delta == 0 apos as falhas)",
    ).toBe(0);

    // ===================================================================
    // FASE 2 — REDELIVERY enquanto processed_at IS NULL: M redeliveries CONCORRENTES do
    // caminho feliz (record + efeito + mark-processed na MESMA tx) + 1 reenvio tardio
    // SEQUENCIAL. Exactly-once: 1 aplica, as demais sao no-op.
    // ===================================================================
    const retries = await Promise.all(
      Array.from({ length: M_RETRY }, (_unused, i) =>
        deliverAsync<WebhookOutcome>("processAsaasWebhook", 100 + i, payloadFor()),
      ),
    );
    const retryProcessErrors = retries.filter((r) => r.outcome === null);
    expect(
      retryProcessErrors,
      `nenhuma redelivery pode falhar como processo:\n${JSON.stringify(retryProcessErrors, null, 2)}`,
    ).toHaveLength(0);

    // Reenvio SEQUENCIAL tardio (o Asaas reenfileira ate 2xx). Apos a rajada ter
    // concluido e marcado processed_at, esta entrega DEVE cair no ramo duplicate.
    const lateOutcome = deliverSync(payloadFor());
    const allRetryOutcomes: WebhookOutcome[] = [
      ...retries.map((r) => r.outcome as WebhookOutcome),
      lateOutcome,
    ];
    expect(allRetryOutcomes.length, "total de M_RETRY + 1 redeliveries do caminho feliz").toBe(
      M_RETRY + 1,
    );

    // ASSERT 1 (efeito exactly-once / steps#1): apos a redelivery, o efeito e aplicado
    // EXACTLY-ONCE: exatamente 1 redelivery foi `changed` (aplicou o commit); as demais
    // sao no-op (duplicate ou changed:false pelo CAS das flags). O pedido alcanca paid 1x.
    const changedRetries = allRetryOutcomes.filter(
      (o) => o.duplicate === false && o.result.found === true && o.result.ok && o.result.changed,
    );
    expect(
      changedRetries.length,
      "exatamente 1 redelivery aplica o efeito (changed); as outras sao no-op",
    ).toBe(1);
    expect(lateOutcome.duplicate, "o reenvio tardio DEVE ser duplicate (no-op apos sucesso)").toBe(
      true,
    );

    // stock/reserved baixam EXATAMENTE 1x (S->S-QTY, R->R-QTY). Nunca 2x.
    const prodFinal = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(prodFinal.rows[0].stock, "stock baixou EXACTLY-ONCE: STOCK - QTY (nunca 2x)").toBe(
      STOCK - QTY,
    );
    expect(prodFinal.rows[0].reserved, "reserved baixou EXACTLY-ONCE: RESERVED - QTY").toBe(
      RESERVED - QTY,
    );
    expect(Number.isInteger(prodFinal.rows[0].stock)).toBe(true);
    expect(Number.isInteger(prodFinal.rows[0].reserved)).toBe(true);

    // pedido pago 1x; flags coerentes com o commit.
    const orderFinal = await client.query<{
      stock_reserved: boolean;
      stock_committed: boolean;
      payment_status: string;
    }>(`SELECT stock_reserved, stock_committed, payment_status FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(orderFinal.rows[0].payment_status, "pedido alcanca paid 1x").toBe("paid");
    expect(orderFinal.rows[0].stock_committed, "stockCommitted == true ao final").toBe(true);
    expect(orderFinal.rows[0].stock_reserved, "stockReserved == false ao final").toBe(false);

    // ASSERT 2 (webhook-idempotent / steps#2): webhook_events tem 1 UNICA linha p/
    // (provider,event_id); processed_at saiu de NULL -> timestamp EXATAMENTE 1x (a
    // entrega que deu 500 deixou processed_at NULL, permitindo o retry seguro).
    const ledgerFinal = await client.query<{
      cnt: string;
      processed_at: Date | null;
      type: string;
    }>(
      `SELECT COUNT(*) OVER ()::text AS cnt, processed_at, type
         FROM "webhook_events" WHERE provider = 'asaas' AND event_id = $1`,
      [eventId],
    );
    expect(
      ledgerFinal.rowCount,
      "exatamente 1 linha em webhook_events p/ (provider,event_id)",
    ).toBe(1);
    expect(
      Number(ledgerFinal.rows[0].cnt),
      "a UNIQUE (provider,eventId) impede linhas duplicadas sob falha+retry",
    ).toBe(1);
    expect(
      ledgerFinal.rows[0].processed_at,
      "processed_at foi setado 1x (NULL -> timestamp) na redelivery bem-sucedida",
    ).not.toBeNull();
    expect(ledgerFinal.rows[0].type, "type do evento preservado").toBe(event);

    // ASSERT 3 (sem duplicacao apos sucesso): a redelivery apos o sucesso NAO reaplica
    // (guard por processedAt nao-NULL + CAS das flags do pedido). Ja coberto: o reenvio
    // tardio e duplicate e o estoque baixou 1x. Reforco: nenhuma redelivery extra mexeu.
    const duplicateRetries = allRetryOutcomes.filter((o) => o.duplicate === true);
    expect(
      duplicateRetries.length,
      "ao menos 1 redelivery cai em duplicate (ledger ja processado); as demais sao no-op",
    ).toBeGreaterThanOrEqual(1);

    // ASSERT 4 (audit-same-tx): o EFEITO e auditado EXATAMENTE 1x, na MESMA transacao do
    // efeito, e a falha+retry NAO duplica.
    //  (a) ha auditoria do commit: 1 linha action 'order.payment_status_update',
    //      before.paymentStatus='pending'/after.paymentStatus='paid',
    //      after.systemFlow=true e after.stockEffect='commit' (fluxo de sistema, ator
    //      anonimo: actor_clerk_user_id/actor_email/actor_role NULL).
    //  (b) delta == 1 (jamais N_FAIL+M_RETRY+1): o 500 nao deixou audit (rollback) e o
    //      CAS das flags so deixa UMA redelivery reivindicar o commit.
    const auditAfterOrder = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE entity_type = 'order' AND entity_id = $1`,
      [String(orderId)],
    );
    const auditAfterGlobal = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const deltaOrder = Number(auditAfterOrder.rows[0].count) - baseAuditOrder;
    const deltaGlobal = Number(auditAfterGlobal.rows[0].count) - baseAuditGlobal;
    expect(
      deltaOrder,
      "efeito auditado 1x; 500+retry NAO duplica (delta do pedido == 1, jamais N+M+1)",
    ).toBe(1);
    expect(deltaGlobal, "exatamente 1 linha de audit_log criada por todas as entregas").toBe(1);

    const auditRow = await client.query<{
      action: string;
      before: { paymentStatus?: string } | null;
      after: { paymentStatus?: string; systemFlow?: boolean; stockEffect?: string } | null;
      actor_clerk_user_id: string | null;
      actor_email: string | null;
      actor_role: string | null;
    }>(
      `SELECT action, before, after, actor_clerk_user_id, actor_email, actor_role
         FROM "audit_log"
        WHERE entity_type = 'order' AND entity_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [String(orderId)],
    );
    expect(auditRow.rowCount, "exatamente 1 linha de audit do commit").toBe(1);
    expect(auditRow.rows[0].action, "action e order.payment_status_update (DB @map)").toBe(
      "order.payment_status_update",
    );
    expect(auditRow.rows[0].before?.paymentStatus, "before.paymentStatus == pending").toBe(
      "pending",
    );
    expect(auditRow.rows[0].after?.paymentStatus, "after.paymentStatus == paid").toBe("paid");
    expect(auditRow.rows[0].after?.systemFlow, "after.systemFlow == true (fluxo de sistema)").toBe(
      true,
    );
    expect(auditRow.rows[0].after?.stockEffect, "after.stockEffect == commit").toBe("commit");
    expect(
      auditRow.rows[0].actor_clerk_user_id,
      "ator anonimo de sistema (sem Clerk user)",
    ).toBeNull();
    expect(auditRow.rows[0].actor_email, "ator anonimo de sistema (sem email)").toBeNull();
    expect(auditRow.rows[0].actor_role, "ator anonimo de sistema (sem role)").toBeNull();

    // CHECK 0<=reserved<=stock valido: existe e nenhuma linha o viola pos-falha+retry.
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
  } finally {
    await client.end();
  }
});

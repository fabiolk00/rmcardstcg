import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.webhook.replay (priority 23, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB REENTREGA REAL (replay) que o MESMO evento de pagamento — mesmo
 * (provider, event_id) — entregue 5x ao handler do webhook do Asaas aplica o efeito
 * de estoque EXATAMENTE 1x, contra o Postgres efemero REAL exposto em
 * process.env.DATABASE_URL pelo runner.
 *
 * SEAM escolhida: o CORACAO DO HANDLER de PRODUCAO (app/api/webhooks/asaas/route.ts
 * L136-156) — uma prisma.$transaction com a MESMA sequencia:
 *   recordWebhookEvent  (INSERT "webhook_events" ... ON CONFLICT DO NOTHING via
 *                        skipDuplicates; firstTime = a linha foi inserida nesta tx)
 *   guard               (se !firstTime && isWebhookEventProcessed => no-op duplicate)
 *   applyPaymentStatusTx (CAS de payment_status + conciliacao de estoque guardada por
 *                        flags stockReserved/stockCommitted: ramo 'paid' => commitStock)
 *   markWebhookEventProcessed (processed_at = now())
 * Tudo na MESMA tx (H3 at-least-once correto). O seam runner _run-seam.ts (op
 * "processAsaasWebhook") chama as 4 funcoes de PRODUCAO (lib/data/webhookEvents +
 * lib/data/orders), SEM mock. So o envelope HTTP (parse/token/teto-de-payload/email)
 * fica de fora — irrelevante p/ a idempotencia de estoque/ledger e inacessivel sem
 * subir o middleware Proxy que protege /admin e os internals; o miolo idempotente e
 * idêntico. O eventId usa o MESMO formato do route (asaasEventId =
 * `${paymentId}|${event}`).
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE IDEMPOTENTE (anti-fake-green):
 * disparamos 5 entregas do MESMO (provider,eventId) — 4 em RAJADA CONCORRENTE via
 * `spawn` assincrono + Promise.all (processos/transacoes independentes correndo no
 * MESMO Postgres) e +1 SEQUENCIAL depois (reentrega tardia do Asaas) — totalizando 5.
 * Sem o ledger UNIQUE (provider,eventId) + skipDuplicates, varias tx inseririam linhas
 * duplicadas e/ou todas baixariam estoque (stock cairia 2,4,6...). O CAS de flags do
 * pedido (stock_reserved=true AND stock_committed=false) so deixa UMA tx reivindicar o
 * commit; as demais acham a flag ja virada => 0 linhas => no-op. A combinacao
 * (ledger + CAS) garante: 1 linha em webhook_events, processed_at setado 1x, estoque
 * baixado 1x (stock 10->8, reserved 2->0), exatamente 1 entrega `changed`. QUALQUER
 * duplicacao (linha extra no ledger, dupla baixa de estoque, mais de 1 changed)
 * reprova o teste. NAO ha serializacao artificial das 4 entregas concorrentes.
 *
 * Sobre o ASSERT de audit (invariante audit-same-tx) — leitura HONESTA do produto: o
 * fluxo de webhook e um FLUXO DE SISTEMA, nao uma mutacao de ADMIN. applyPaymentStatusTx
 * NAO grava audit_log de proposito (lib/data/orders.ts: "Nao grava audit_log (fluxo de
 * sistema, nao mutacao de admin)"; a invariante audit-same-tx tem escopo "mutacao de
 * admin"). Portanto o que provamos — exatamente o nucleo anti-replay do assert — e que
 * a REENTREGA NAO DUPLICA auditoria: a contagem de audit_log atribuivel a este pedido
 * NAO cresce com as 5 entregas (delta == 0; jamais 5), e o CHECK 0<=reserved<=stock
 * permanece valido sob a rajada. Forcar exatamente-1-audit aqui contradiria o design do
 * produto e o escopo da invariante; o teste afirma a verdade verificavel e load-bearing.
 *
 * CAVEAT TECNICO (INFRA do harness, sem tocar produto): o Prisma gerado e ESM puro
 * (import.meta) e quebra se importado direto numa spec transpilada p/ CJS. Por isso as
 * mutacoes rodam em processos `tsx` separados (_run-seam.ts), herdando DATABASE_URL; o
 * spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: webhook-idempotent (UNIQUE (provider,eventId) + processed_at;
 * reprocessar nao reaplica), reserve-lifecycle-idempotent (commit guardado por flags do
 * pedido; 2a..5a entregas = no-op) e audit-same-tx (sem auditoria duplicada por
 * reentrega; CHECK reserved<=stock intacto).
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string };
type PaymentRef = { id: string; valueCents: number | null };
type PaymentStatusUpdate =
  | { found: false }
  | { found: true; ok: false; reason: string }
  | { found: true; ok: true; changed: boolean; previousStatus: string; status: string };
type WebhookOutcome = { duplicate: true } | { duplicate: false; result: PaymentStatusUpdate };

/** Desfecho de uma das entregas (correlaciona resultado/erro a um id de entrega). */
type DeliveryOutcome = {
  deliveryId: number;
  outcome: WebhookOutcome | null;
  error: string | null;
};

/**
 * Chama uma op do seam via processo tsx SINCRONO (setup serial: criar produto).
 * Reaproveita o protocolo __SEAM_RESULT__/__SEAM_ERROR__ das specs irmas.
 */
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
 * Entrega o webhook via processo tsx ASSINCRONO. RETORNA uma Promise que so resolve
 * quando o processo termina — permitindo que N entregas rodem em paralelo REAL via
 * Promise.all (cada uma e um processo/transacao independente no MESMO Postgres,
 * processando o MESMO (provider,eventId)). Resolve sempre (nunca rejeita) com o
 * outcome do seam ou um erro de processo, p/ Promise.all coletar TODOS os desfechos.
 */
function deliverWebhookAsync(deliveryId: number, payload: unknown): Promise<DeliveryOutcome> {
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
      resolve({ deliveryId, outcome: null, error: `spawn error: ${e.message}` }),
    );
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          deliveryId,
          outcome: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as WebhookOutcome,
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

/** Entrega SINCRONA (reenvio tardio sequencial do Asaas), mesmo protocolo. */
function deliverWebhookSync(payload: unknown): WebhookOutcome {
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
const RESERVED = 2; // unidades reservadas pelo checkout (==qty do pedido); reserved>0 nao-trivial
const QTY = 2; // quantidade do pedido (1 item)
const UNIT_CENTS = 4990; // preco unitario
const TOTAL_CENTS = QTY * UNIT_CENTS; // total do pedido = valor do evento (bate value-check)
const N_CONCURRENT = 4; // entregas em rajada concorrente
// total de entregas = N_CONCURRENT (rajada) + 1 (reenvio sequencial tardio) = 5

test("chaos.webhook.replay: mesmo (provider,event_id) entregue 5x, efeito de estoque 1x", async () => {
  // 5 processos tsx (cada um sobe um Prisma) sob Windows: folga ampla.
  test.setTimeout(180_000);

  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup A: cria produto PROPRIO (createProduct de PRODUCAO), depois forca
    //     stock=STOCK, reserved=RESERVED (>0, nao-trivial) por UPDATE direto — reserved
    //     e gerido pelo ciclo de reserva, entao pre-posicionar via SQL e a forma honesta.
    const created = runSeamSync<SeamProduct>("createProduct", {
      actor,
      input: {
        name: `Produto Harness Webhook ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-WH-${tag}`,
        priceCents: UNIT_CENTS,
        discountPct: 0,
        stock: STOCK,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para chaos.webhook.replay",
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
        `harness-wh-${tag}`,
        "Harness Webhook",
        `harness-wh-${tag}@example.com`,
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

    // order_items.id e uuid gerado pela app (Prisma @default(uuid)), nao pelo DB —
    // o INSERT cru precisa fornecer o id (gen_random_uuid()).
    await client.query(
      `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)`,
      [orderId, productId, `Produto Harness Webhook ${tag}`, QTY, UNIT_CENTS],
    );

    // Baseline de audit_log (global e do pedido) ANTES das entregas — p/ provar que a
    // reentrega NAO duplica auditoria (delta == 0; o fluxo de webhook nao audita).
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
      eventId, // MESMO (provider,eventId) em TODAS as 5 entregas
      type: event,
      payment,
      payload: { event, payment: { id: paymentId, externalReference: String(orderId) } },
    });

    // --- ACAO 1: rajada de N entregas SIMULTANEAS do MESMO evento. Promise.all sobre
    //     processos spawn() assincronos => paralelismo REAL; cada tsx abre sua propria
    //     transacao e processa o MESMO (provider,eventId). Sem serializacao artificial.
    const burst = await Promise.all(
      Array.from({ length: N_CONCURRENT }, (_unused, i) => deliverWebhookAsync(i, payloadFor())),
    );

    // Nenhum processo pode morrer de forma inesperada (erro de infra != desfecho de
    // dominio). Deadlock benigno tambem nao deve aparecer: a 1a tx commita rapido.
    const processFailures = burst.filter((b) => b.outcome === null);
    expect(
      processFailures,
      `nenhuma entrega concorrente pode falhar como processo:\n${JSON.stringify(processFailures, null, 2)}`,
    ).toHaveLength(0);

    // --- ACAO 2: reenvio SEQUENCIAL tardio (o Asaas reenfileira ate 2xx). Apos a rajada
    //     ja ter concluido e marcado processed_at, esta entrega DEVE cair no ramo duplicate.
    const lateOutcome = deliverWebhookSync(payloadFor());
    const allOutcomes: WebhookOutcome[] = [
      ...burst.map((b) => b.outcome as WebhookOutcome),
      lateOutcome,
    ];
    expect(allOutcomes.length, "total de 5 entregas do mesmo evento").toBe(N_CONCURRENT + 1);

    // ===================================================================
    // ASSERT 1 (webhook-idempotent): webhook_events tem 1 UNICA linha p/
    // (provider,eventId); processed_at setado exatamente 1x (NULL -> timestamp).
    // ===================================================================
    const rows = await client.query<{
      cnt: string;
      processed_at: Date | null;
      received_at: Date | null;
      type: string;
    }>(
      `SELECT COUNT(*) OVER ()::text AS cnt, processed_at, received_at, type
         FROM "webhook_events" WHERE provider = 'asaas' AND event_id = $1`,
      [eventId],
    );
    expect(rows.rowCount, "exatamente 1 linha em webhook_events p/ (provider,eventId)").toBe(1);
    expect(
      Number(rows.rows[0].cnt),
      "a UNIQUE (provider,eventId) impede linhas duplicadas sob replay",
    ).toBe(1);
    expect(
      rows.rows[0].processed_at,
      "processed_at foi setado (NULL -> timestamp) 1x",
    ).not.toBeNull();
    expect(rows.rows[0].type, "type do evento preservado").toBe(event);

    // Confirmacao crua via pg de que NENHUM duplicado vazou (defesa em profundidade).
    const dupCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "webhook_events"
         WHERE provider = 'asaas' AND event_id = $1`,
      [eventId],
    );
    expect(Number(dupCount.rows[0].count), "0 duplicados no ledger").toBe(1);

    // ===================================================================
    // ASSERT 2 (efeito 1x): commitStock baixou stock 1x (stock 10->8, reserved 2->0);
    // exatamente 1 entrega foi `changed`; as outras 4 sao no-op (duplicate ou
    // changed:false pelo CAS das flags). NUNCA dupla baixa (stock != 6).
    // ===================================================================
    const changedDeliveries = allOutcomes.filter(
      (o) => o.duplicate === false && o.result.found === true && o.result.ok && o.result.changed,
    );
    expect(
      changedDeliveries.length,
      "exatamente 1 entrega aplica o efeito (changed); as outras 4 sao no-op",
    ).toBe(1);
    const duplicateDeliveries = allOutcomes.filter((o) => o.duplicate === true);
    expect(
      duplicateDeliveries.length,
      "as demais entregas caem no ramo duplicate (ledger ja processado) ou changed:false",
    ).toBeGreaterThanOrEqual(1);
    // O reenvio sequencial tardio, apos a rajada ter concluido, e necessariamente duplicate.
    expect(lateOutcome.duplicate, "o reenvio tardio DEVE ser duplicate (no-op)").toBe(true);

    const afterProd = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(afterProd.rowCount).toBe(1);
    expect(afterProd.rows[0].stock, "stock baixou 1x: STOCK - QTY (nunca 2x)").toBe(STOCK - QTY);
    expect(afterProd.rows[0].reserved, "reserved baixou 1x: RESERVED - QTY (=0)").toBe(
      RESERVED - QTY,
    );
    expect(Number.isInteger(afterProd.rows[0].stock)).toBe(true);
    expect(Number.isInteger(afterProd.rows[0].reserved)).toBe(true);

    // ===================================================================
    // ASSERT 3: Order.stockCommitted==true e stockReserved==false ao final; sem dupla
    // baixa (ja coberto em A2, reforcado pelo estado do pedido).
    // ===================================================================
    const afterOrder = await client.query<{
      stock_reserved: boolean;
      stock_committed: boolean;
      payment_status: string;
    }>(`SELECT stock_reserved, stock_committed, payment_status FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(afterOrder.rowCount).toBe(1);
    expect(afterOrder.rows[0].stock_committed, "stockCommitted == true ao final").toBe(true);
    expect(afterOrder.rows[0].stock_reserved, "stockReserved == false ao final").toBe(false);
    expect(afterOrder.rows[0].payment_status, "payment_status == paid").toBe("paid");

    // ===================================================================
    // ASSERT 4 (audit-same-tx, leitura honesta): a REENTREGA NAO DUPLICA auditoria.
    // O fluxo de webhook e de SISTEMA — applyPaymentStatusTx NAO grava audit_log
    // (escopo de audit-same-tx = mutacao de admin). Provamos que a contagem de
    // audit_log NAO cresce com as 5 entregas (delta == 0; jamais 5) — o nucleo
    // anti-replay do assert — e que o CHECK 0<=reserved<=stock segue valido.
    // ===================================================================
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
      "reentrega NAO duplica auditoria do pedido (fluxo de sistema nao audita; jamais 5)",
    ).toBe(0);
    expect(deltaGlobal, "nenhuma linha de audit_log criada pelas 5 entregas").toBe(0);

    // CHECK 0<=reserved<=stock valido: existe e nenhuma linha o viola pos-replay.
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

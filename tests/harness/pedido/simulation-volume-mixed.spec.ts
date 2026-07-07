import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * SIMULACAO EM VOLUME: 18 pedidos x 9 cenarios de pagamento (2 por cenario),
 * criados pelo CHECKOUT DE PRODUCAO (createOrderWithReservation: pedido + itens +
 * reserva atomica) e movidos pelo MIOLO REAL do webhook do Asaas (asaasWebhookTx
 * no seam runner = record + guard de idempotencia + applyPaymentStatusTx +
 * mark-processed, as MESMAS funcoes do route). No fim, VALIDACAO GLOBAL de
 * integridade via pg + RELATORIO no stdout.
 *
 * Cenarios (mapeados ao dominio REAL de 3 estados pending|paid|cancelled — a spec
 * NAO inventa estados tipo partially_refunded/disputed que o produto nao tem):
 *   1. pix_success          RECEIVED correto -> paid (commit de estoque)
 *   2. duplicate_redelivery RECEIVED entregue 3x (mesmo eventId) -> 1 efeito + 2 duplicate
 *   3. refund_after_paid    RECEIVED -> REFUNDED -> cancelled (restock)
 *   4. chargeback           RECEIVED -> CHARGEBACK_REQUESTED -> cancelled (restock)
 *   5. expire_pending       DELETED -> cancelled (release da reserva)
 *   6. out_of_order         DELETED -> RECEIVED depois: invalid_transition (cancelled e terminal)
 *   7. value_mismatch       RECEIVED com valor errado -> rejeitado, pedido segue pending
 *   8. payment_mismatch     RECEIVED com payment.id de OUTRA cobranca -> rejeitado
 *   9. transient_500_retry  RECEIVED com 500 injetado (rollback) -> reentrega aplica 1x
 *
 * DADOS PROPRIOS: 3 produtos exclusivos do run (SKU com tag) + 18 pedidos com
 * checkoutKey proprio; nada do seed e tocado, e specs paralelas nao interferem.
 * Plano DETERMINISTICO: PRNG com seed fixa (mulberry32) decide itens/quantidades,
 * entao a contabilidade esperada de estoque e derivavel e estavel entre runs.
 *
 * Invariantes provadas em VOLUME: exactly-once por (provider,eventId), maquina de
 * estados terminal, ledger 100% processed, conciliacao reserva->commit->restock/
 * release por cenario, CHECK 0<=reserved<=stock e formula de dinheiro dos pedidos.
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

function runSeam<T>(op: string, payload: unknown): T {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
    encoding: "utf8",
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32",
    maxBuffer: 16 * 1024 * 1024,
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

/** PRNG deterministico (mulberry32) — plano reproduzivel entre runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCENARIOS = [
  "pix_success",
  "duplicate_redelivery",
  "refund_after_paid",
  "chargeback",
  "expire_pending",
  "out_of_order",
  "value_mismatch",
  "payment_mismatch",
  "transient_500_retry",
] as const;
type Scenario = (typeof SCENARIOS)[number];
const PER_SCENARIO = 2; // 9 x 2 = 18 pedidos

const STOCK0 = 300; // estoque inicial de cada produto fixture
const SHIPPING_CENTS = 2000;
const PRODUCT_PRICES = [2500, 4999, 12000]; // centavos, discountPct 0

// Desfecho final esperado por cenario, no dominio real de 3 estados.
const FINAL: Record<
  Scenario,
  { paymentStatus: string; stockReserved: boolean; stockCommitted: boolean }
> = {
  pix_success: { paymentStatus: "paid", stockReserved: false, stockCommitted: true },
  duplicate_redelivery: { paymentStatus: "paid", stockReserved: false, stockCommitted: true },
  refund_after_paid: { paymentStatus: "cancelled", stockReserved: false, stockCommitted: false },
  chargeback: { paymentStatus: "cancelled", stockReserved: false, stockCommitted: false },
  expire_pending: { paymentStatus: "cancelled", stockReserved: false, stockCommitted: false },
  out_of_order: { paymentStatus: "cancelled", stockReserved: false, stockCommitted: false },
  value_mismatch: { paymentStatus: "pending", stockReserved: true, stockCommitted: false },
  payment_mismatch: { paymentStatus: "pending", stockReserved: true, stockCommitted: false },
  transient_500_retry: { paymentStatus: "paid", stockReserved: false, stockCommitted: true },
};

type SeamProduct = { id: string };
type CreatedOrder =
  | { ok: true; reused: boolean; orderId: number }
  | { ok: false; reason: string; productId: string };
type WebhookOutcome =
  | { duplicate: true }
  | { failed: true }
  | {
      duplicate: false;
      result:
        | { found: false }
        | { found: true; ok: false; reason: string }
        | { found: true; ok: true; changed: boolean };
    };

test("pedido.simulation.volume-mixed: 18 pedidos x 9 cenarios via checkout+webhook reais, integridade global", async () => {
  // Lote de 5 processos seam + ~30 transacoes: mais lento que uma spec pontual.
  test.slow();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  expect(process.env.DATABASE_URL, "DATABASE_URL do harness").toBeTruthy();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const rand = mulberry32(0x524d2026 & 0x7fffffff); // "RM 2026", fixa e reproduzivel

    // --- fase 1: 3 produtos fixture exclusivos do run.
    const products = PRODUCT_PRICES.map((priceCents, i) =>
      runSeam<SeamProduct>("createProduct", {
        actor: { clerkUserId: null, email: null, role: null },
        input: {
          name: `Produto Sim ${tag}-${i}`,
          category: "Booster Box",
          sku: `SIM-${tag}-${i}`,
          priceCents,
          discountPct: 0,
          stock: STOCK0,
          badge: null,
          imageUrl: "/products/placeholder.svg",
          description: "fixture da simulacao em volume",
        },
      }),
    );

    // --- fase 2: plano deterministico de 18 pedidos (itens/qty via PRNG seedado).
    type Plan = {
      scenario: Scenario;
      paymentId: string;
      items: { productIdx: number; quantity: number }[];
      totalCents: number;
    };
    const plan: Plan[] = [];
    for (const scenario of SCENARIOS) {
      for (let k = 0; k < PER_SCENARIO; k++) {
        const nItems = 1 + Math.floor(rand() * 2); // 1..2 produtos distintos
        const first = Math.floor(rand() * products.length);
        const idxs = nItems === 1 ? [first] : [first, (first + 1) % products.length];
        const items = idxs.map((productIdx) => ({
          productIdx,
          quantity: 1 + Math.floor(rand() * 3), // 1..3 unidades
        }));
        const subtotal = items.reduce(
          (acc, it) => acc + PRODUCT_PRICES[it.productIdx] * it.quantity,
          0,
        );
        plan.push({
          scenario,
          paymentId: `pay_sim_${tag}_${plan.length}`,
          items,
          totalCents: subtotal + SHIPPING_CENTS,
        });
      }
    }

    // --- fase 3: checkout de PRODUCAO em lote (pedido + itens + reserva na mesma tx).
    const created = runSeam<CreatedOrder[]>("createOrdersBatch", {
      orders: plan.map((p, i) => ({
        checkoutKey: `sim-${tag}-${i}`,
        userId: `user-sim-${tag}`,
        customerName: `Cliente Sim ${i}`,
        customerEmail: `sim-${tag}-${i}@harness.test`,
        customerPhone: "11999999999",
        address: { cep: "01001000", street: "Rua Sim", city: "Sao Paulo", state: "SP" },
        items: p.items.map((it) => ({
          productId: products[it.productIdx].id,
          productName: `Produto Sim ${tag}-${it.productIdx}`,
          quantity: it.quantity,
          unitPriceCents: PRODUCT_PRICES[it.productIdx],
        })),
        subtotalCents: p.totalCents - SHIPPING_CENTS,
        discountCents: 0,
        shippingCents: SHIPPING_CENTS,
        totalCents: p.totalCents,
        paymentMethod: "pix",
      })),
    });
    expect(created).toHaveLength(plan.length);
    const orderIds = created.map((c, i) => {
      expect(c.ok, `checkout ${i} (${plan[i].scenario}) deve criar o pedido`).toBe(true);
      if (!c.ok) throw new Error("unreachable");
      expect(c.reused, `checkout ${i} nao deve reusar (checkoutKey inedito)`).toBe(false);
      return c.orderId;
    });

    // Vincula a cobranca do Asaas (como setAsaasRefs faz apos criar a cobranca) —
    // pre-condicao do anti-replay payment.id == orders.asaas_payment_id.
    for (let i = 0; i < orderIds.length; i++) {
      await client.query(`UPDATE "orders" SET asaas_payment_id = $1 WHERE id = $2`, [
        plan[i].paymentId,
        orderIds[i],
      ]);
    }

    // --- fase 4: plano de ENTREGAS de webhook por cenario (eventId = payment|event,
    //     o MESMO formato do route). expected: como cada entrega deve terminar.
    type Delivery = {
      orderId: number;
      status: "paid" | "cancelled";
      eventId: string;
      type: string;
      payment: { id: string; valueCents: number | null };
      failBeforeMark?: boolean;
      expected: "applied" | "noop" | "duplicate" | "failed" | `rejected:${string}`;
    };
    const deliveries: Delivery[] = [];
    plan.forEach((p, i) => {
      const orderId = orderIds[i];
      const ok = { id: p.paymentId, valueCents: p.totalCents };
      const ev = (event: string) => `${p.paymentId}|${event}`;
      const push = (d: Omit<Delivery, "orderId">) => deliveries.push({ orderId, ...d });

      switch (p.scenario) {
        case "pix_success":
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: ok, expected: "applied" });
          break;
        case "duplicate_redelivery":
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: ok, expected: "applied" });
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: ok, expected: "duplicate" });
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: ok, expected: "duplicate" });
          break;
        case "refund_after_paid":
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: ok, expected: "applied" });
          push({ status: "cancelled", eventId: ev("PAYMENT_REFUNDED"), type: "PAYMENT_REFUNDED", payment: ok, expected: "applied" });
          break;
        case "chargeback":
          push({ status: "paid", eventId: ev("PAYMENT_CONFIRMED"), type: "PAYMENT_CONFIRMED", payment: ok, expected: "applied" });
          push({ status: "cancelled", eventId: ev("PAYMENT_CHARGEBACK_REQUESTED"), type: "PAYMENT_CHARGEBACK_REQUESTED", payment: ok, expected: "applied" });
          break;
        case "expire_pending":
          push({ status: "cancelled", eventId: ev("PAYMENT_DELETED"), type: "PAYMENT_DELETED", payment: ok, expected: "applied" });
          break;
        case "out_of_order":
          push({ status: "cancelled", eventId: ev("PAYMENT_DELETED"), type: "PAYMENT_DELETED", payment: ok, expected: "applied" });
          // Confirmacao chega DEPOIS do cancelamento: cancelled e terminal.
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: ok, expected: "rejected:invalid_transition" });
          break;
        case "value_mismatch":
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: { id: p.paymentId, valueCents: p.totalCents + 1234 }, expected: "rejected:value_mismatch" });
          break;
        case "payment_mismatch":
          push({ status: "paid", eventId: `pay_wrong_${tag}_${i}|PAYMENT_RECEIVED`, type: "PAYMENT_RECEIVED", payment: { id: `pay_wrong_${tag}_${i}`, valueCents: p.totalCents }, expected: "rejected:payment_mismatch" });
          break;
        case "transient_500_retry":
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: ok, failBeforeMark: true, expected: "failed" });
          // Reentrega do Asaas apos o 500: o rollback desfez o ledger, entao NAO e
          // duplicate — aplica agora, exatamente 1 efeito no total.
          push({ status: "paid", eventId: ev("PAYMENT_RECEIVED"), type: "PAYMENT_RECEIVED", payment: ok, expected: "applied" });
          break;
      }
    });

    const outcomes = runSeam<WebhookOutcome[]>("processAsaasWebhookBatch", {
      deliveries: deliveries.map(({ expected: _e, ...d }) => d),
    });
    expect(outcomes).toHaveLength(deliveries.length);

    // --- assert por entrega: desfecho igual ao esperado do plano.
    const tally = { applied: 0, duplicate: 0, rejected: 0, failed: 0 };
    outcomes.forEach((out, i) => {
      const want = deliveries[i].expected;
      const label = `entrega ${i} (${deliveries[i].type} -> pedido ${deliveries[i].orderId}, espera ${want})`;
      if (want === "failed") {
        expect(out, label).toEqual({ failed: true });
        tally.failed++;
        return;
      }
      if (want === "duplicate") {
        expect(out, label).toEqual({ duplicate: true });
        tally.duplicate++;
        return;
      }
      expect("duplicate" in out && out.duplicate === false, label).toBe(true);
      const applied = (out as Extract<WebhookOutcome, { duplicate: false }>).result;
      expect(applied.found, label).toBe(true);
      if (want.startsWith("rejected:")) {
        expect(applied, label).toMatchObject({ ok: false, reason: want.slice("rejected:".length) });
        tally.rejected++;
      } else {
        expect(applied, label).toMatchObject({ ok: true, changed: true });
        tally.applied++;
      }
    });

    // --- assert global 1: estado final de CADA pedido (status + flags do ledger).
    const rows = await client.query<{
      id: number;
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
      subtotal_cents: number;
      discount_cents: number;
      shipping_cents: number;
      total_cents: number;
    }>(
      `SELECT id, payment_status, stock_reserved, stock_committed,
              subtotal_cents, discount_cents, shipping_cents, total_cents
         FROM "orders" WHERE id = ANY($1::int[])`,
      [orderIds],
    );
    expect(rows.rowCount).toBe(plan.length);
    const byId = new Map(rows.rows.map((r) => [Number(r.id), r]));
    plan.forEach((p, i) => {
      const row = byId.get(orderIds[i])!;
      const want = FINAL[p.scenario];
      const label = `pedido ${orderIds[i]} (${p.scenario})`;
      expect(row.payment_status, `${label}: payment_status`).toBe(want.paymentStatus);
      expect(row.stock_reserved, `${label}: stock_reserved`).toBe(want.stockReserved);
      expect(row.stock_committed, `${label}: stock_committed`).toBe(want.stockCommitted);
      // Formula de dinheiro (cents-only): total = subtotal - discount + shipping.
      expect(
        row.total_cents,
        `${label}: total = subtotal - discount + shipping`,
      ).toBe(row.subtotal_cents - row.discount_cents + row.shipping_cents);
      expect(row.total_cents, `${label}: total igual ao do plano`).toBe(p.totalCents);
    });

    // --- assert global 2: contabilidade de ESTOQUE por produto, derivada do plano.
    //     reserva no checkout; commit em paid (stock-,reserved-); restock no
    //     refund/chargeback de pago (stock+); release no cancel de pending
    //     (reserved-); mismatch mantem a reserva.
    const expectedStock = products.map(() => STOCK0);
    const expectedReserved = products.map(() => 0);
    plan.forEach((p) => {
      const f = FINAL[p.scenario];
      for (const it of p.items) {
        if (f.paymentStatus === "paid") {
          expectedStock[it.productIdx] -= it.quantity; // commit definitivo
        } else if (f.paymentStatus === "pending") {
          expectedReserved[it.productIdx] += it.quantity; // reserva viva
        }
        // cancelled: released (pending) ou committed+restocked (pago) => neutro.
      }
    });
    for (let i = 0; i < products.length; i++) {
      const prod = await client.query<{ stock: number; reserved: number }>(
        `SELECT stock, reserved FROM "products" WHERE id = $1`,
        [products[i].id],
      );
      expect(prod.rows[0].stock, `produto ${i}: stock final`).toBe(expectedStock[i]);
      expect(prod.rows[0].reserved, `produto ${i}: reserved final`).toBe(expectedReserved[i]);
    }
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products" WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "0 violacoes de 0<=reserved<=stock").toBe(0);

    // --- assert global 3: ledger webhook_events — exatamente 1 linha por eventId
    //     DISTINTO entregue com sucesso (o 500 sofreu rollback e sumiu; a reentrega
    //     recriou), todas processed (processed_at NOT NULL).
    const distinctEventIds = [...new Set(deliveries.filter((d) => !d.failBeforeMark).map((d) => d.eventId))];
    const ledger = await client.query<{ total: string; processed: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::text AS processed
         FROM "webhook_events" WHERE provider = 'asaas' AND event_id = ANY($1::text[])`,
      [distinctEventIds],
    );
    expect(Number(ledger.rows[0].total), "1 linha por eventId distinto").toBe(distinctEventIds.length);
    expect(Number(ledger.rows[0].processed), "ledger 100% processed").toBe(distinctEventIds.length);

    // --- relatorio da simulacao (stdout do harness).
    const statusDist = new Map<string, number>();
    for (const p of plan) {
      const s = FINAL[p.scenario].paymentStatus;
      statusDist.set(s, (statusDist.get(s) ?? 0) + 1);
    }
    console.log(
      [
        `[simulacao ${tag}] RELATORIO`,
        `  pedidos criados:      ${plan.length} (checkout de producao, 0 reused)`,
        `  entregas de webhook:  ${deliveries.length}`,
        `  aplicadas:            ${tally.applied}`,
        `  duplicadas (no-op):   ${tally.duplicate}`,
        `  rejeitadas:           ${tally.rejected} (value/payment mismatch, invalid_transition)`,
        `  500 transitorio:      ${tally.failed} (rollback + reentrega aplicada)`,
        `  status final:         ${[...statusDist].map(([s, n]) => `${s}=${n}`).join(" ")}`,
        `  ledger:               ${distinctEventIds.length} eventos, 100% processed, 0 duplicatas`,
        `  estoque:              conferido por produto (commit/restock/release), 0 violacoes de CHECK`,
      ].join("\n"),
    );
  } finally {
    await client.end();
  }
});

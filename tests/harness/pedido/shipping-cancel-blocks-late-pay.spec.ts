import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.shipping.cancel-blocks-late-pay (regressao) — DB-first, sem browser.
 *
 * PROVA a correcao do achado "paid-without-stock-commit + oversell via shipping-cancel
 * de pedido pendente": cancelar o ENVIO de um pedido ainda pendente de pagamento agora
 * cancela o PAGAMENTO na MESMA tx (updateOrderShippingStatus, lib/data/orders.ts), de
 * modo que um webhook 'paid' POSTERIOR e rejeitado como invalid_transition e o estoque
 * NUNCA e baixado — fechando o oversell.
 *
 * PRE-FIX (comportamento bugado): shipping-cancel liberava a reserva mas deixava
 * payment_status='pending'; o PIX seguia pagavel; um applyPaymentStatusTx('paid')
 * (pending->paid, transicao LEGAL) flipava para 'paid', mas o CAS de 'paid' nao achava
 * stock_reserved=true (ja liberado) => commitStock era no-op => pedido PAGO sem baixa +
 * unidade liberada revendida = oversell. Este spec falharia no PRE-FIX: o
 * applyPaymentStatus retornaria ok:true/changed:true e payment_status viraria 'paid'.
 *
 * SEAMS de PRODUCAO (via tests/harness/estoque/_run-seam.ts, mesmo motivo de ESM/CJS
 * das specs irmas): (1) updateOrderShippingStatus(orderId,'cancelled',actor) e
 * (2) applyPaymentStatus(orderId,'paid',payment) — o nucleo do webhook Asaas
 * (applyPaymentStatusTx envelopado num $transaction, como setOrderPaymentStatus). O
 * spec faz TODAS as assercoes via `pg`.
 *
 * asaas_payment_id e setado no pedido (a verificacao anti-replay exige payment.id ==
 * orders.asaas_payment_id) e o payment.valueCents casa o total (para o ramo de 'paid'
 * passar o value-check e chegar de fato na guarda de transicao — provando
 * invalid_transition, nao value_mismatch).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type AdminOrderUpdate =
  | { ok: false; reason: string; from?: string; to?: string }
  | { ok: true; changed: boolean; order: { shippingStatus: string; paymentStatus?: string } };
type PaymentStatusUpdate =
  | { found: false }
  | { found: true; ok: false; reason: string }
  | { found: true; ok: true; changed: boolean; previousStatus: string; status: string };

/** Chama uma op do seam via processo tsx; devolve a linha __SEAM_RESULT__ parseada. */
function runSeam<T>(op: string, payload: unknown): T {
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

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const QTY = 2; // unidades do item do pedido (> 0)
const STOCK0 = 5; // estoque fisico (deve ficar INTOCADO: nem estorno nem commit o mexem)
const RESERVED0 = 3; // reserva pre-existente (> QTY p/ o estorno nao zerar reserved)
const UNIT_PRICE = 4999; // centavos (Int) por unidade

test("pedido.shipping.cancel-blocks-late-pay: cancelar envio de pedido pendente cancela o pagamento; webhook 'paid' posterior e rejeitado e o estoque nunca baixa", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };
    const asaasPaymentId = `pay_${tag}`;

    // --- setup A: produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness LatePay ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-LATEPAY-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999, // irrelevante; forcado abaixo
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para shipping-cancel-blocks-late-pay",
      },
    });
    const productId = created.id;

    // --- setup B: FORCA reserved=RESERVED0(>QTY) e stock=STOCK0 (reserva ativa).
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK0,
      RESERVED0,
      productId,
    ]);

    // --- setup C: PEDIDO PROPRIO pendente + 1 item (QTY). stockReserved=true /
    //     stockCommitted=false (reserva ativa, nao pago). asaas_payment_id setado p/ a
    //     verificacao anti-replay do applyPaymentStatusTx casar depois.
    const subtotal = UNIT_PRICE * QTY;
    const ins = await client.query<{ id: number }>(
      `INSERT INTO "orders" (
         clerk_user_id, customer_name, customer_email, customer_phone,
         address_cep, address_street, address_city, address_state,
         subtotal_cents, discount_cents, shipping_cents, total_cents,
         payment_status, payment_method, shipping_status,
         stock_reserved, stock_committed, asaas_payment_id
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, 0, 0, $10,
         'pending', 'pix', 'pending',
         true, false, $11
       ) RETURNING id`,
      [
        `user-${tag}`,
        "Cliente Harness",
        `cliente-${tag}@harness.test`,
        "11999999999",
        "01001000",
        "Rua Teste",
        "Sao Paulo",
        "SP",
        subtotal,
        subtotal, // shipping/discount 0 => total = subtotal
        asaasPaymentId,
      ],
    );
    const orderId = ins.rows[0].id;

    await client.query(
      `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), orderId, productId, `Produto Harness LatePay ${tag}`, QTY, UNIT_PRICE],
    );

    // --- acao 1: cancelar o ENVIO do pedido pendente.
    const cancel = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId,
      to: "cancelled",
      actor,
    });
    expect(cancel.ok, "shipping pending->cancelled deve ser ok").toBe(true);

    // --- assert 1: o cancelamento do envio ACOPLOU o cancelamento do pagamento, e a
    //     reserva foi estornada (stock INTOCADO).
    const afterCancel = await client.query<{
      shipping_status: string;
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(
      `SELECT shipping_status, payment_status, stock_reserved, stock_committed
         FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(afterCancel.rows[0].shipping_status, "shipping_status='cancelled'").toBe("cancelled");
    expect(
      afterCancel.rows[0].payment_status,
      "payment_status cancelado junto (fecha o oversell)",
    ).toBe("cancelled");
    expect(afterCancel.rows[0].stock_reserved, "stock_reserved estornado (false)").toBe(false);
    expect(afterCancel.rows[0].stock_committed, "stock_committed continua false").toBe(false);

    const midP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(midP.rows[0].stock, "stock INTOCADO apos o estorno").toBe(STOCK0);
    expect(midP.rows[0].reserved, "reserved decrementado em QTY (estorno)").toBe(RESERVED0 - QTY);

    // --- acao 2: webhook 'paid' POSTERIOR (o cliente paga o PIX ainda aberto). payment.id
    //     casa asaas_payment_id; valueCents casa o total (passa o value-check e chega na
    //     guarda de transicao).
    const pay = runSeam<PaymentStatusUpdate>("applyPaymentStatus", {
      orderId,
      status: "paid",
      payment: { id: asaasPaymentId, valueCents: subtotal },
    });

    // --- assert 2: a transicao cancelled->paid e REJEITADA (invalid_transition) — sem
    //     "ressurreicao" do pedido cancelado.
    expect(pay.found, "pedido encontrado").toBe(true);
    if (pay.found) {
      expect(pay.ok, "cancelled->paid deve ser rejeitada").toBe(false);
      if (!pay.ok) {
        expect(pay.reason, "motivo = invalid_transition").toBe("invalid_transition");
      }
    }

    // --- assert 3: estado FINAL — pedido segue cancelled/cancelled, estoque NUNCA baixou
    //     (stock=STOCK0, stock_committed=false). Este e o coracao do fix: sem "pago sem
    //     baixa", sem unidade fantasma revendivel.
    const fin = await client.query<{
      payment_status: string;
      stock_committed: boolean;
    }>(`SELECT payment_status, stock_committed FROM "orders" WHERE id = $1`, [orderId]);
    expect(fin.rows[0].payment_status, "payment_status segue 'cancelled' (nao ressuscitou)").toBe(
      "cancelled",
    );
    expect(fin.rows[0].stock_committed, "stock_committed segue false (nunca baixou)").toBe(false);

    const finP = await client.query<{ stock: number }>(
      `SELECT stock FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(finP.rows[0].stock, "stock fisico INTOCADO (0 baixas): oversell fechado").toBe(STOCK0);
  } finally {
    await client.end();
  }
});

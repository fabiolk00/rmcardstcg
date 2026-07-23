import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.shipping.sent-requires-payment (regra nova) — DB-first, sem browser.
 *
 * REGRA: o pedido, quando pago, aparece IMEDIATAMENTE como pago pro cliente — mas o
 * status de ENVIO nunca "segue" o pagamento sozinho. 'sent' (Enviado) so pode ser
 * marcado pelo admin, e SOMENTE quando paymentStatus='paid' — nunca despachamos o que
 * ainda nao foi pago. As duas direcoes do desacoplamento:
 *  (a) pagar NAO avanca o envio sozinho (ja coberto em payment-pending-to-paid.spec.ts
 *      e provado de novo aqui via o CAMINHO REAL do webhook do Asaas);
 *  (b) marcar 'sent' EXIGE pagamento confirmado — a regra NOVA que este arquivo prova.
 *
 * SEAM escolhida: updateOrderShippingStatus(orderId, 'sent', actor) de
 * lib/data/orders.ts — mesma funcao de PRODUCAO das specs irmas (shipping-pending-to-
 * sent, shipping-skip-blocked). A guarda nova roda ANTES do CAS (fail-fast com
 * reason='payment_required') e e REPETIDA no WHERE do UPDATE (fecha a corrida com um
 * refund concorrente — provado sob concorrencia REAL em chaos-ship-sent-vs-refund.spec.ts
 * irmao deste). NAO chamamos updateOrderShippingStatusAction (comeca com requireAdmin(),
 * contexto de request) — a action so DELEGA para a funcao de PRODUCAO testada aqui.
 *
 * Tambem usa applyPaymentStatus (nucleo do webhook do Asaas, orders.ts
 * applyPaymentStatusTx) para a cena 3, provando a regra pelo caminho de producao mais
 * comum (confirmacao via webhook), nao so pelo ajuste manual do admin.
 *
 * CAVEAT TECNICO (INFRA do harness, sem tocar produto): Prisma gerado e ESM puro
 * (import.meta), incompativel com a transpilacao CJS do Playwright — as MUTACOES rodam
 * num processo `tsx` separado (tests/harness/estoque/_run-seam.ts), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
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

const QTY = 2;
const UNIT_PRICE = 4999;

/** Insere um PEDIDO PROPRIO com paymentStatus/shippingStatus configuraveis + 1 item. */
async function insertOrder(
  client: Client,
  productId: string,
  tag: string,
  paymentStatus: string,
  asaasPaymentId: string | null = null,
): Promise<{ orderId: number; total: number }> {
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
       $11, 'pix', 'pending',
       true, false, $12
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
      subtotal,
      paymentStatus,
      asaasPaymentId,
    ],
  );
  const orderId = ins.rows[0].id;
  await client.query(
    `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), orderId, productId, `Produto Harness SentPay ${tag}`, QTY, UNIT_PRICE],
  );
  return { orderId, total: subtotal };
}

async function shipAuditCount(client: Client, orderId: number): Promise<number> {
  const r = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "audit_log"
       WHERE entity_id = $1 AND entity_type = 'order'
         AND action = 'order.shipping_status_update'`,
    [String(orderId)],
  );
  return Number(r.rows[0].count);
}

test("pedido.shipping.sent-requires-payment: pending->sent barrado (payment_required) quando payment != paid; libera assim que paga", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };

    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness SentPay ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-SENTPAY-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para shipping-sent-requires-payment",
      },
    });
    const productId = created.id;
    // FORCA reserved>0/stock: anti-trivialidade — se o bloqueio escapasse e tocasse
    // estoque por engano, isso mudaria; provamos abaixo que NAO muda.
    await client.query(`UPDATE "products" SET stock = 20, reserved = 6 WHERE id = $1`, [productId]);

    // =========================================================================
    // CENA 1: payment_status='pending' -> 'sent' e BARRADO (payment_required).
    // =========================================================================
    const pending = await insertOrder(client, productId, `${tag}-pend`, "pending");
    const preP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );

    const blockedPending = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId: pending.orderId,
      to: "sent",
      actor,
    });
    expect(blockedPending.ok, "pending->sent com payment 'pending' deve ser barrado").toBe(false);
    if (!blockedPending.ok) {
      expect(blockedPending.reason, "reason deve ser 'payment_required'").toBe("payment_required");
      expect(blockedPending.from).toBe("pending");
      expect(blockedPending.to).toBe("sent");
    }

    const afterBlockedPending = await client.query<{
      shipping_status: string;
      payment_status: string;
    }>(`SELECT shipping_status, payment_status FROM "orders" WHERE id = $1`, [pending.orderId]);
    expect(
      afterBlockedPending.rows[0].shipping_status,
      "shipping_status permanece 'pending' (nada gravado)",
    ).toBe("pending");
    expect(afterBlockedPending.rows[0].payment_status, "payment_status intocado").toBe("pending");
    expect(
      await shipAuditCount(client, pending.orderId),
      "bloqueio nao audita (retorna antes de writeAuditLog)",
    ).toBe(0);

    // =========================================================================
    // CENA 2: payment_status='cancelled' -> 'sent' TAMBEM e barrado (mesma regra;
    // 'cancelled' e tao "nao-pago" quanto 'pending' pra fins de despacho).
    // =========================================================================
    const cancelled = await insertOrder(client, productId, `${tag}-canc`, "cancelled");
    const blockedCancelled = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId: cancelled.orderId,
      to: "sent",
      actor,
    });
    expect(blockedCancelled.ok, "pending->sent com payment 'cancelled' deve ser barrado").toBe(
      false,
    );
    if (!blockedCancelled.ok) {
      expect(blockedCancelled.reason).toBe("payment_required");
    }
    const afterBlockedCancelled = await client.query<{ shipping_status: string }>(
      `SELECT shipping_status FROM "orders" WHERE id = $1`,
      [cancelled.orderId],
    );
    expect(
      afterBlockedCancelled.rows[0].shipping_status,
      "shipping_status permanece 'pending' (nada gravado)",
    ).toBe("pending");
    expect(await shipAuditCount(client, cancelled.orderId), "bloqueio nao audita").toBe(0);

    // Estoque continua intocado pelos dois bloqueios (nenhum efeito colateral).
    const postP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(postP.rows[0].stock, "stock intacto apos os bloqueios").toBe(preP.rows[0].stock);
    expect(postP.rows[0].reserved, "reserved intacto apos os bloqueios").toBe(
      preP.rows[0].reserved,
    );

    // =========================================================================
    // CONTRA-PROVA (o bloqueio nao e tautologico): o MESMO pedido da cena 1, uma vez
    // pago (ajuste manual do admin), passa a aceitar 'sent' normalmente.
    // =========================================================================
    const paidNow = runSeam<AdminOrderUpdate>("adjustOrderPaymentStatus", {
      orderId: pending.orderId,
      to: "paid",
      reason: `confirmado manualmente no harness ${tag}`,
      actor,
    });
    expect(paidNow.ok, "ajuste manual pending->paid deve aplicar").toBe(true);

    const nowAllowed = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId: pending.orderId,
      to: "sent",
      actor,
    });
    expect(nowAllowed.ok, "contra-prova: pending->sent libera assim que payment='paid'").toBe(true);
    if (nowAllowed.ok) {
      expect(nowAllowed.changed).toBe(true);
      expect(nowAllowed.order.shippingStatus).toBe("sent");
    }
    const finalRow = await client.query<{ shipping_status: string; payment_status: string }>(
      `SELECT shipping_status, payment_status FROM "orders" WHERE id = $1`,
      [pending.orderId],
    );
    expect(finalRow.rows[0].shipping_status).toBe("sent");
    expect(finalRow.rows[0].payment_status).toBe("paid");
    expect(
      await shipAuditCount(client, pending.orderId),
      "a transicao LEGAL (apos pagar) deixa exatamente 1 audit de envio (o bloqueio nao deixou nenhum)",
    ).toBe(1);
  } finally {
    await client.end();
  }
});

test("pedido.shipping.sent-requires-payment: confirmar pagamento via WEBHOOK real (applyPaymentStatus) nao avanca o envio; 'sent' so libera depois, pelo admin", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };
    const asaasPaymentId = `pay_${tag}`;

    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness SentPayWebhook ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-SENTPAYWH-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para shipping-sent-requires-payment (webhook)",
      },
    });
    const productId = created.id;
    await client.query(`UPDATE "products" SET stock = 20, reserved = 2 WHERE id = $1`, [productId]);

    const { orderId, total } = await insertOrder(
      client,
      productId,
      `${tag}-wh`,
      "pending",
      asaasPaymentId,
    );

    // --- pedido pendente: 'sent' ainda barrado (mesma regra da cena 1 acima).
    const beforePay = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId,
      to: "sent",
      actor,
    });
    expect(beforePay.ok, "antes do pagamento, 'sent' segue barrado").toBe(false);

    // --- webhook do Asaas confirma o pagamento (o CAMINHO REAL de producao, nao o
    //     ajuste manual do admin). payment.id casa asaas_payment_id; valueCents casa
    //     o total (passa o value-check em applyPaymentStatusTx).
    const paid = runSeam<PaymentStatusUpdate>("applyPaymentStatus", {
      orderId,
      status: "paid",
      payment: { id: asaasPaymentId, valueCents: total },
    });
    expect(paid.found && paid.ok && paid.changed, "webhook deve confirmar pending->paid").toBe(
      true,
    );

    // --- REGRA (a): o webhook NAO avanca o envio sozinho — shipping_status segue
    //     'pending' ("a enviar" pro cliente) mesmo com o pagamento ja confirmado.
    const afterWebhook = await client.query<{
      payment_status: string;
      shipping_status: string;
    }>(`SELECT payment_status, shipping_status FROM "orders" WHERE id = $1`, [orderId]);
    expect(afterWebhook.rows[0].payment_status, "pagamento confirmado pelo webhook").toBe("paid");
    expect(
      afterWebhook.rows[0].shipping_status,
      "webhook de pagamento NAO toca o envio — continua 'pending'",
    ).toBe("pending");

    // --- REGRA (b): SO AGORA, com o pagamento confirmado, o admin consegue marcar
    //     'sent' — a acao explicita que a regra exige.
    const afterPay = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId,
      to: "sent",
      actor,
    });
    expect(afterPay.ok, "depois do pagamento confirmado, o admin PODE marcar 'sent'").toBe(true);
    if (afterPay.ok) {
      expect(afterPay.order.shippingStatus).toBe("sent");
    }
  } finally {
    await client.end();
  }
});

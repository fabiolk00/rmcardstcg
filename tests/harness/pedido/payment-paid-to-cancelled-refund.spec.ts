import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.payment.paid-to-cancelled-refund (priority 3) — DB-first, sem browser.
 *
 * Prova "admin marca pagamento paid -> cancelled (refund repoe estoque)" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas verdes
 * (payment-pending-to-paid.spec.ts, payment-pending-to-cancelled.spec.ts): roda em
 * Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: adjustOrderPaymentStatus(orderId, 'cancelled', reason, actor) de
 * lib/data/orders.ts (L624) — a funcao de menor nivel que prova as invariantes:
 * abre prisma.$transaction, le o pedido (before), valida X->X no-op, faz o CAS de
 * payment_status (updateMany WHERE paymentStatus=from) e concilia o estoque via
 * reconcileStockForPaymentStatus (orders.ts L457-474). Para um pedido JA PAGO
 * (stock_committed=true, stock_reserved=false) o ramo 'cancelled' funciona em 2
 * passos:
 *   1) CAS de release: UPDATE ... SET stock_reserved=false
 *      WHERE id=? AND stock_reserved=true AND stock_committed=false  -> 0 linhas
 *      (committed=true reprova o predicado), entao releaseStock NAO roda;
 *   2) CAS de refund: UPDATE ... SET stock_committed=false
 *      WHERE id=? AND stock_committed=true                            -> 1 linha,
 *      e SO entao restockUnits(tx, lines): products.stock += qty (reserved INTOCADO).
 * O audit_log (action order.payment_status_update, after.manualAdjustment=true /
 * adjustmentReason=reason) e gravado na MESMA tx. NAO chamamos a server action
 * adjustOrderPaymentStatusAction porque ela comeca com requireAdmin() (contexto de
 * request: next/headers, Clerk), que quebra fora do HTTP; a action so DELEGA para
 * adjustOrderPaymentStatus. O runner _run-seam.ts (INFRA) ja suporta a op
 * adjustOrderPaymentStatus — nenhuma extensao de infra nesta sessao.
 *
 * DADOS PROPRIOS (anti-trivialidade): criamos um PRODUTO proprio (createProduct,
 * SKU/nome unicos por run) e um PEDIDO proprio (INSERT direto em `pg`) no estado
 * inicial do ledger — paymentStatus=paid, stockReserved=false, stockCommitted=true
 * (estoque ja baixado por commitStock no momento do pagamento). FORCAMOS o produto
 * a um estado pos-commit coerente: reserved=RESERVED0(>0) e stock=STOCK0. reserved
 * e gerido pelo ciclo de reserva (nunca por escrita de admin avulsa), entao o
 * UPDATE direto e a forma honesta de montar o pre-estado. reserved=RESERVED0>0 (e
 * INDEPENDENTE de QTY) e proposital: prova que o refund repoe SO stock e deixa
 * reserved INTOCADO (distinguindo restock de release). Assim o efeito e REAL e
 * nao-trivial (stock STOCK0 -> STOCK0+QTY; reserved RESERVED0 -> RESERVED0).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as MUTACOES (createProduct/adjustOrderPaymentStatus) rodam num
 * processo `tsx` separado (tests/harness/estoque/_run-seam.ts); o spec faz TODAS as
 * assercoes via `pg`.
 *
 * Invariantes cobertas: order-state-machine (paid->cancelled legal via CAS),
 * reserve-lifecycle-idempotent (stock_committed vira false via CAS no proprio pedido;
 * restock repoe o que o commit baixou), reserved-le-stock (CHECK + 0 violacoes),
 * audit-same-tx (1 linha na mesma tx, action/before/after corretos).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type AdminOrderUpdate =
  | { ok: false; reason: string }
  | { ok: true; changed: boolean; order: { paymentStatus: string } };

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

const QTY = 3; // unidades do item do pedido (forcado > 0 p/ tornar o efeito nao-trivial)
const STOCK0 = 10; // estoque FISICO pos-commit (deve subir p/ STOCK0+QTY apos o refund)
const RESERVED0 = 2; // reserva pre-existente (>0 e INDEPENDENTE de QTY: refund nao toca reserved)
const UNIT_PRICE = 4999; // centavos (Int) por unidade

test("pedido.payment.paid-to-cancelled-refund: refund repoe estoque e audita na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const reason = `refund manual harness ${tag}`;
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };

    // --- setup A: produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness Refund ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-REFUND-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999, // valor inicial irrelevante; forcado abaixo
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para payment-paid-to-cancelled-refund",
      },
    });
    const productId = created.id;

    // --- setup B: FORCA reserved=RESERVED0(>0) e stock=STOCK0 (estado pos-commit
    //     coerente). reserved e gerido pelo ciclo de reserva (nunca por escrita de
    //     admin avulsa), entao o UPDATE direto e a forma honesta de montar o
    //     pre-estado. RESERVED0 e INDEPENDENTE de QTY (prova que o refund repoe SO
    //     stock e deixa reserved INTOCADO). RESERVED0 <= STOCK0 respeita o CHECK.
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK0,
      RESERVED0,
      productId,
    ]);

    // --- setup C: PEDIDO PROPRIO no estado inicial do ledger (paid, stockReserved=
    //     false, stockCommitted=true — estoque ja baixado por commitStock no
    //     pagamento) + 1 item (QTY) deste produto. INSERT direto em pg (a criacao
    //     de pedido de producao passa pelo checkout/Asaas, fora do escopo).
    const subtotal = UNIT_PRICE * QTY;
    const ins = await client.query<{ id: number }>(
      `INSERT INTO "orders" (
         clerk_user_id, customer_name, customer_email, customer_phone,
         address_cep, address_street, address_city, address_state,
         subtotal_cents, discount_cents, shipping_cents, total_cents,
         payment_status, payment_method, shipping_status,
         stock_reserved, stock_committed
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, 0, 0, $10,
         'paid', 'pix', 'pending',
         false, true
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
      ],
    );
    const orderId = ins.rows[0].id;

    await client.query(
      `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), orderId, productId, `Produto Harness Refund ${tag}`, QTY, UNIT_PRICE],
    );

    // Sanidade do pre-estado (anti-trivialidade: pago, committed, reserved>0).
    const pre = await client.query<{
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT payment_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(pre.rows[0].payment_status).toBe("paid");
    expect(pre.rows[0].stock_reserved, "pre: stockReserved=false (ja committed)").toBe(false);
    expect(pre.rows[0].stock_committed, "pre: stockCommitted=true").toBe(true);

    const preP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(preP.rows[0].stock, "pre: stock=STOCK0").toBe(STOCK0);
    expect(preP.rows[0].reserved, "pre: reserved=RESERVED0 (>0, nao trivial)").toBe(RESERVED0);
    expect(RESERVED0).toBeGreaterThan(0);

    // Contagem de audit antes (total e por entity_id do PEDIDO). entity_id de pedido
    // e String(orderId) (schema usa string p/ acomodar uuid de produto e int de pedido).
    const entityId = String(orderId);
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    // Pedido recem-inserido nao tem audit ainda; o ajuste manual deve somar +1.
    expect(auditForEntityBefore, "pedido novo nao tem audit ainda").toBe(0);

    // --- acao: adjustOrderPaymentStatus(orderId, 'cancelled', reason, actor) (seam de PRODUCAO).
    const res = runSeam<AdminOrderUpdate>("adjustOrderPaymentStatus", {
      orderId,
      to: "cancelled",
      reason,
      actor,
    });
    expect(res.ok, "ajuste deve ser ok").toBe(true);
    if (res.ok) {
      expect(res.changed, "transicao paid->cancelled deve aplicar (changed=true)").toBe(true);
      expect(res.order.paymentStatus, "order retornado em cancelled").toBe("cancelled");
    }

    // --- assert 1: orders.payment_status == 'cancelled' (transicao legal paid->cancelled).
    const ord = await client.query<{
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT payment_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(ord.rowCount).toBe(1);
    expect(ord.rows[0].payment_status, "payment_status deve virar 'cancelled'").toBe("cancelled");

    // --- assert 2: restockUnits aplicado: products.stock += QTY (reposicao);
    //     products.reserved INALTERADO. Order.stockCommitted == false (flag virada
    //     via CAS); stockReserved continua false (refund nunca religa a reserva).
    const postP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(postP.rowCount).toBe(1);
    expect(postP.rows[0].stock, "stock deve subir QTY (reposicao do refund)").toBe(STOCK0 + QTY);
    expect(
      postP.rows[0].reserved,
      "reserved deve permanecer RESERVED0 (refund nao toca reserved)",
    ).toBe(RESERVED0);
    expect(Number.isInteger(postP.rows[0].stock)).toBe(true);
    expect(Number.isInteger(postP.rows[0].reserved)).toBe(true);
    // Flags do pedido (reserve-lifecycle): committed virou false; reserved segue false.
    expect(ord.rows[0].stock_committed, "stockCommitted deve virar false").toBe(false);
    expect(ord.rows[0].stock_reserved, "stockReserved deve continuar false").toBe(false);

    // --- assert (reserved-le-stock): CHECK existe + 0 violacoes de 0<=reserved<=stock.
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    // Reforco direto sobre o produto da feature (stock cresceu, reserved intacto).
    expect(postP.rows[0].reserved).toBeGreaterThanOrEqual(0);
    expect(postP.rows[0].reserved).toBeLessThanOrEqual(postP.rows[0].stock);

    // --- assert 3: audit_log recebe EXATAMENTE 1 linha nova p/ o pedido, action=
    //     order.payment_status_update, na MESMA tx, com adjustmentReason (e
    //     manualAdjustment=true marcando que foi intervencao humana de admin).
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    expect(Number(afterAudit.rows[0].total), "audit_log total deve ganhar 1 linha").toBe(
      auditTotalBefore + 1,
    );
    expect(Number(afterAudit.rows[0].forEntity), "este pedido deve ganhar 1 linha de audit").toBe(
      auditForEntityBefore + 1,
    );

    const log = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: { paymentStatus: string } | null;
      after: {
        paymentStatus: string;
        manualAdjustment?: boolean;
        adjustmentReason?: string;
      } | null;
    }>(
      `SELECT action, entity_type, entity_id, before, after
         FROM "audit_log"
         WHERE entity_id = $1 AND entity_type = 'order'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      [entityId],
    );
    expect(log.rowCount).toBe(1);
    const a = log.rows[0];

    // action gravado com o valor DOTTED do @map (schema.prisma:
    // order_payment_status_update @map("order.payment_status_update")). Lemos a coluna
    // crua via pg, nao a chave JS do enum.
    expect(a.action, "action deve ser o valor @map dotted").toBe("order.payment_status_update");
    expect(a.entity_type).toBe("order");
    expect(a.entity_id).toBe(entityId);

    // before/after sao snapshots do dominio (camelCase). before.paymentStatus=paid,
    // after.paymentStatus=cancelled + os marcadores de ajuste manual do admin.
    expect(a.before, "before deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.after, "after deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.before!.paymentStatus, "before.paymentStatus deve refletir 'paid'").toBe("paid");
    expect(a.after!.paymentStatus, "after.paymentStatus deve refletir 'cancelled'").toBe(
      "cancelled",
    );
    expect(a.after!.manualAdjustment, "after.manualAdjustment deve ser true").toBe(true);
    expect(a.after!.adjustmentReason, "after.adjustmentReason deve ser a reason informada").toBe(
      reason,
    );
  } finally {
    await client.end();
  }
});

import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.payment.idempotent-noop (priority 6) — DB-first, sem browser.
 *
 * Prova "reaplicar o MESMO status de pagamento e no-op idempotente" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs de pedido ja
 * verdes (payment-pending-to-paid.spec.ts): roda em Node (sem `page`) e assertaa o
 * estado real via `pg`.
 *
 * SEAM escolhida: adjustOrderPaymentStatus(orderId, 'paid', reason, actor) de
 * lib/data/orders.ts (L624) — a funcao de PRODUCAO do ajuste manual do admin. Ela
 * abre prisma.$transaction, le o pedido (before) e, quando from===to (X->X), retorna
 * { ok:true, changed:false, order } IMEDIATAMENTE (L641-643), ANTES do CAS de
 * payment_status, ANTES de reconcileStockForPaymentStatus e ANTES de writeAuditLog.
 * Logo: nada muda no pedido, nada baixa de estoque (sem dupla baixa) e nenhuma linha
 * de audit nasce. NAO chamamos a server action adjustOrderPaymentStatusAction porque
 * ela comeca com requireAdmin() (contexto de request: next/headers, Clerk), que
 * quebra fora do HTTP; a action so DELEGA para adjustOrderPaymentStatus.
 *
 * DADOS PROPRIOS (anti-trivialidade): criamos um PRODUTO proprio (createProduct,
 * SKU/nome unicos por run) e um PEDIDO proprio (INSERT direto em `pg`) JA NO ESTADO
 * PAGO do ledger — paymentStatus=paid, stockCommitted=true, stockReserved=false —
 * com 1 item de QTY>0. ANTES do no-op FORCAMOS o produto a refletir um estado pos-
 * commit + uma reserva residual NAO-ZERO (reserved=RESERVED_RESID>0, stock=STOCK0)
 * via UPDATE direto. Esse reserved>0 e o gatilho anti-trivial: SE o no-op deixasse
 * vazar uma segunda conciliacao 'paid' (dupla baixa), o CAS de commit
 *   WHERE stock_reserved=true AND stock_committed=false
 * NAO casaria (o pedido ja esta committed=true/reserved=false), mas mantemos reserved
 * do PRODUTO > 0 p/ que qualquer escrita indevida em stock/reserved seja DETECTADA
 * pela assercao de igualdade exata abaixo. reserved e gerido pelo ciclo de reserva
 * (reserveStock no checkout), nunca por escrita de admin avulsa, entao o seed direto
 * e a forma honesta de montar o pre-estado (RESERVED_RESID <= STOCK0 respeita o CHECK).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as MUTACOES (createProduct/adjustOrderPaymentStatus) rodam num
 * processo `tsx` separado (tests/harness/estoque/_run-seam.ts), herdando DATABASE_URL;
 * o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: order-state-machine (X->X e no-op idempotente, sem transicao),
 * reserve-lifecycle-idempotent (flags stockCommitted/stockReserved inalteradas; 2x =
 * no-op, sem dupla baixa), audit-same-tx (nenhuma linha orfa: a guarda retorna ANTES
 * do writeAuditLog, entao 0 linhas novas).
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

const QTY = 3; // unidades do item do pedido (forcado > 0)
const STOCK0 = 7; // estoque do produto no estado pos-commit (ja baixado)
const RESERVED_RESID = 2; // reserva residual NAO-ZERO (anti-trivial; RESERVED_RESID <= STOCK0)
const UNIT_PRICE = 4999; // centavos (Int) por unidade

test("pedido.payment.idempotent-noop: reaplicar paid->paid e no-op (changed=false, sem efeito, sem audit)", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const reason = `ajuste manual harness noop ${tag}`;
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };

    // --- setup A: produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness Noop ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-NOOP-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999, // valor inicial irrelevante; forcado abaixo
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para payment-idempotent-noop",
      },
    });
    const productId = created.id;

    // --- setup B: FORCA stock=STOCK0 (pos-commit) e reserved=RESERVED_RESID(>0). reserved
    //     e gerido pelo ciclo de reserva (nunca por escrita de admin avulsa), entao o UPDATE
    //     direto e a forma honesta de montar o pre-estado (RESERVED_RESID <= STOCK0 respeita
    //     o CHECK products_reserved_le_stock_chk). O reserved>0 e o canario anti-trivial:
    //     qualquer dupla baixa indevida seria flagrada pela igualdade exata pos-acao.
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK0,
      RESERVED_RESID,
      productId,
    ]);

    // --- setup C: PEDIDO PROPRIO JA NO ESTADO PAGO do ledger (paid, stockCommitted=true,
    //     stockReserved=false) + 1 item (QTY) deste produto. INSERT direto em pg (a criacao
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
      [randomUUID(), orderId, productId, `Produto Harness Noop ${tag}`, QTY, UNIT_PRICE],
    );

    // Sanidade do pre-estado: pedido ja PAGO e committed (X==paid), produto com reserved>0.
    const pre = await client.query<{
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT payment_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(pre.rows[0].payment_status, "pre: paymentStatus=paid (from==to)").toBe("paid");
    expect(pre.rows[0].stock_reserved, "pre: stockReserved=false (ja committed)").toBe(false);
    expect(pre.rows[0].stock_committed, "pre: stockCommitted=true (ja committed)").toBe(true);

    const preP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(preP.rows[0].stock, "pre: stock=STOCK0").toBe(STOCK0);
    expect(preP.rows[0].reserved, "pre: reserved=RESERVED_RESID (>0, canario anti-trivial)").toBe(
      RESERVED_RESID,
    );
    expect(RESERVED_RESID).toBeGreaterThan(0);

    // --- step "Conta audit_log = A" (total + por entity_id do PEDIDO). entity_id de pedido
    //     e String(orderId) (schema usa string p/ acomodar uuid de produto e int de pedido).
    const entityId = String(orderId);
    const beforeAudit = await client.query<{ total: string; forEntity: string; forAction: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity",
         (SELECT COUNT(*) FROM "audit_log"
            WHERE entity_id = $1 AND entity_type = 'order'
              AND action = 'order.payment_status_update')::text AS "forAction"`,
      [entityId],
    );
    const auditTotalA = Number(beforeAudit.rows[0].total);
    const auditForEntityA = Number(beforeAudit.rows[0].forEntity);
    const auditForActionA = Number(beforeAudit.rows[0].forAction);
    // Pedido recem-inserido (INSERT cru) nao gera audit; A para este pedido = 0.
    expect(auditForEntityA, "pedido novo (INSERT cru) nao tem audit ainda").toBe(0);

    // --- acao: adjustOrderPaymentStatus(orderId, 'paid', reason, actor) com from==to (paid->paid).
    const res = runSeam<AdminOrderUpdate>("adjustOrderPaymentStatus", {
      orderId,
      to: "paid",
      reason,
      actor,
    });

    // --- assert 1: Resultado changed=false (no-op X->X).
    expect(res.ok, "no-op ainda e ok (encontrou e nao precisou mudar)").toBe(true);
    if (res.ok) {
      expect(res.changed, "reaplicar o MESMO status deve ser no-op (changed=false)").toBe(false);
      expect(res.order.paymentStatus, "order retornado permanece 'paid'").toBe("paid");
    }

    // --- assert 2a: orders.payment_status permanece 'paid'; flags do pedido inalteradas.
    const ord = await client.query<{
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT payment_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(ord.rowCount).toBe(1);
    expect(ord.rows[0].payment_status, "payment_status permanece 'paid'").toBe("paid");
    // reserve-lifecycle-idempotent: flags NAO mudam (2x = no-op).
    expect(ord.rows[0].stock_committed, "stockCommitted permanece true").toBe(true);
    expect(ord.rows[0].stock_reserved, "stockReserved permanece false").toBe(false);

    // --- assert 2b: estoque INALTERADO (sem dupla baixa). stock e reserved batem EXATAMENTE
    //     o pre-estado (STOCK0 / RESERVED_RESID). Qualquer reconciliacao vazada teria mexido.
    const postP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(postP.rowCount).toBe(1);
    expect(postP.rows[0].stock, "stock INALTERADO (sem dupla baixa)").toBe(STOCK0);
    expect(postP.rows[0].reserved, "reserved INALTERADO (sem dupla baixa)").toBe(RESERVED_RESID);
    expect(Number.isInteger(postP.rows[0].stock)).toBe(true);
    expect(Number.isInteger(postP.rows[0].reserved)).toBe(true);

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

    // --- assert 3: audit_log NAO ganha linha (count == A). Total global, por-entidade do
    //     pedido e por-action do pedido TODOS inalterados (audit-same-tx: a guarda X->X
    //     retorna ANTES do writeAuditLog => 0 orfaos).
    const afterAudit = await client.query<{ total: string; forEntity: string; forAction: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity",
         (SELECT COUNT(*) FROM "audit_log"
            WHERE entity_id = $1 AND entity_type = 'order'
              AND action = 'order.payment_status_update')::text AS "forAction"`,
      [entityId],
    );
    expect(Number(afterAudit.rows[0].total), "audit_log total NAO muda (count == A)").toBe(
      auditTotalA,
    );
    expect(
      Number(afterAudit.rows[0].forEntity),
      "este pedido NAO ganha linha de audit (count == A)",
    ).toBe(auditForEntityA);
    expect(
      Number(afterAudit.rows[0].forAction),
      "nenhuma linha order.payment_status_update p/ o pedido (count == A)",
    ).toBe(auditForActionA);
    expect(auditForActionA, "baseline de payment_status_update p/ o pedido era 0").toBe(0);
  } finally {
    await client.end();
  }
});

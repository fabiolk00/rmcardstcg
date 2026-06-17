import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.restock.refund-of-paid (priority 14) — DB-first, sem browser.
 *
 * Prova "REFUND de pedido JA PAGO (stockCommitted=true) repoe o estoque baixado"
 * contra o Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (release-reserved-on-cancel.spec.ts / release-idempotent.spec.ts): roda em Node
 * (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida (PRODUCAO, sem mock): o RAMO DE REFUND DE PEDIDO PAGO de
 * reconcileStockForPaymentStatus (lib/data/orders.ts L467-473), reproduzido
 * byte-a-byte no runner _run-seam.ts (op "restockUnitsForOrder"). E o caminho que
 * adjustOrderPaymentStatus(orderId,'cancelled',...) dispara via
 * reconcileStockForPaymentStatus quando o CAS de RELEASE nao reivindica (o pedido
 * nao estava apenas reservado, mas COMMITTED). Numa MESMA $transaction:
 *   (1) le os PROPRIOS itens do pedido (= snap.items na producao);
 *   (2) CAS idempotente do refund:
 *         UPDATE "orders" SET stock_committed=false
 *         WHERE id=? AND stock_committed=true;
 *   (3) SE refunded===1, chama restockUnits REAL (lib/data/inventory) -> stock
 *       += qty; reserved INTOCADO.
 * Nao chamamos a server action direto porque ela exige requireAdmin (contexto de
 * request); o efeito desta feature vive inteiramente no CAS da flag stockCommitted
 * + restockUnits, ambos exercitados sem mock.
 *
 * O QUE ESTA SPEC PROVA (asserts do ledger):
 *   [A1] products.stock += qty (reposicao do estoque baixado); products.reserved
 *        INALTERADO (restockUnits nao toca reserved).
 *   [A2] Order.stockCommitted == false (flag virada via CAS); stockReserved
 *        continua false (pedido pago nao volta a estar reservado).
 *   [A3] CHECK 0<=reserved<=stock valido (stock cresce, reserved intacto): nenhuma
 *        linha viola, e na linha alvo reserved <= stock.
 * Invariantes: reserve-lifecycle-idempotent (flag stockCommitted como guard do CAS),
 * reserved-le-stock.
 *
 * DADOS PROPRIOS (anti-trivialidade): cria um produto e um pedido PROPRIOS (ids
 * unicos por run). Pre-posiciona o ESTADO POS-COMMIT: reserved=RES(>0) e stock=
 * STOCK_AFTER_COMMIT, com o pedido PAGO (payment_status='paid', stockReserved=false,
 * stockCommitted=true) e qty=QTY.
 *   - reserved=RES e FORCADO > 0 (DICA do QA: senao "reserved inalterado" vira
 *     trivial). O refund NAO deve tocar reserved, entao provamos RES antes == RES
 *     depois, com RES>0.
 *   - apos o refund, stock esperado = STOCK_AFTER_COMMIT + QTY, que e != stock antes
 *     (cresce de verdade) e mantem reserved <= stock (RES <= STOCK_AFTER_COMMIT+QTY).
 * reserved e gerido pelo ciclo de reserva (nunca por create/update do produto),
 * entao o UPDATE direto e a forma honesta de pre-posicionar reserved>0.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * p/ CJS, onde import.meta = SyntaxError — importar lib/data/lib/db DIRETO no spec
 * quebra no load. Por isso a MUTACAO (CAS + restockUnits dentro de $transaction)
 * roda num processo `tsx` separado (_run-seam.ts, op "restockUnitsForOrder"),
 * herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type SeamRestock = { refunded: number };

/** Chama uma op do seam via processo tsx; devolve o JSON do __SEAM_RESULT__. */
function runSeam<T>(op: "createProduct" | "restockUnitsForOrder", payload: unknown): T {
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

const RES = 7; // reserved que NAO pode ser tocado pelo refund (>0, nao trivial)
const STOCK_AFTER_COMMIT = 30; // estoque ja BAIXADO pelo commit (cresce no refund)
const QTY = 4; // unidades do pedido (a repor no estoque pelo refund)
const PRICE_CENTS = 24990; // cents do produto (deve ficar INTOCADO)
const STOCK_AFTER_REFUND = STOCK_AFTER_COMMIT + QTY; // stock esperado pos-refund (34)

test("estoque.restock.refund-of-paid: refund de pedido PAGO repoe estoque (stock+=qty), reserved intocado, flag stockCommitted->false via CAS, CHECK valido", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Restock ${tag}`;
    const sku = `HARNESS-RESTOCK-${tag}`;
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup A: cria um produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor,
      input: {
        name,
        category: "Booster Box",
        sku,
        priceCents: PRICE_CENTS,
        discountPct: 0,
        stock: 70,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para restock-refund-of-paid",
      },
    });
    const productId = created.id;

    // --- setup B: pre-posiciona o ESTADO POS-COMMIT: stock JA baixado
    //     (STOCK_AFTER_COMMIT) e reserved=RES(>0). reserved e gerido pelo ciclo de
    //     reserva (nunca por create/update); UPDATE direto e a forma honesta de
    //     pre-posicionar reserved>0. RES <= STOCK_AFTER_COMMIT respeita o CHECK.
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK_AFTER_COMMIT,
      RES,
      productId,
    ]);

    const pre = await client.query<{ stock: number; reserved: number; price_cents: number }>(
      `SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    const prod0 = pre.rows[0];
    expect(prod0.stock, "setup deve deixar stock=STOCK_AFTER_COMMIT").toBe(STOCK_AFTER_COMMIT);
    expect(prod0.reserved, "setup deve deixar reserved=RES (>0, nao trivial)").toBe(RES);
    // DICA do QA: reserved>0 p/ que "reserved inalterado" nao seja trivial.
    expect(RES, "reserved deve ser > 0 (anti-trivialidade)").toBeGreaterThan(0);
    expect(prod0.price_cents, "setup: price_cents do produto").toBe(PRICE_CENTS);

    // --- setup C: cria um pedido PROPRIO PAGO (payment_status='paid') com 1 item
    //     (productId, qty) e flags POS-COMMIT (stockReserved=false, stockCommitted=
    //     true). O refund le os PROPRIOS itens do pedido (como
    //     reconcileStockForPaymentStatus usa snap.items), entao o item real e quem
    //     define as `lines` da reposicao.
    const orderIns = await client.query<{ id: number }>(
      `INSERT INTO "orders" (
         clerk_user_id, customer_name, customer_email, customer_phone,
         address_cep, address_street, address_city, address_state,
         subtotal_cents, total_cents, payment_method,
         payment_status, stock_reserved, stock_committed
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'paid', false, true
       ) RETURNING id`,
      [
        `harness-${tag}`,
        "Harness Restock",
        "harness@example.com",
        "(41) 90000-0000",
        "80000-000",
        "Rua Teste",
        "Curitiba",
        "PR",
        PRICE_CENTS * QTY,
        PRICE_CENTS * QTY,
        "PIX",
      ],
    );
    expect(orderIns.rowCount).toBe(1);
    const orderId = orderIns.rows[0].id;

    // Item do pedido (FK order_items.product_id -> products.id): qty=QTY do nosso produto.
    await client.query(
      `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), orderId, productId, name, QTY, PRICE_CENTS],
    );

    // Sanidade pre-refund: pedido pago, committed (nao reservado).
    const preOrder = await client.query<{
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT payment_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(preOrder.rowCount).toBe(1);
    expect(preOrder.rows[0].payment_status, "pre-refund: pedido PAGO").toBe("paid");
    expect(preOrder.rows[0].stock_committed, "pre-refund: stockCommitted=true").toBe(true);
    expect(preOrder.rows[0].stock_reserved, "pre-refund: stockReserved=false").toBe(false);

    // Sanidade: ambos os CHECKs do ciclo de reserva existem.
    const checks = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conname IN ('products_reserved_nonneg_chk', 'products_reserved_le_stock_chk')`,
    );
    const haveChecks = new Set(checks.rows.map((r) => r.conname));
    expect(
      haveChecks.has("products_reserved_le_stock_chk"),
      "CHECK reserved<=stock deve existir",
    ).toBe(true);
    expect(haveChecks.has("products_reserved_nonneg_chk"), "CHECK reserved>=0 deve existir").toBe(
      true,
    );

    // =========================================================================
    // Aplica o REFUND (estado 'cancelled' de um pedido PAGO): o CAS de release NAO
    // reivindica (stockReserved ja false), entao cai no CAS de refund
    //   WHERE stock_committed=true -> 1 linha (refunded===1)
    // -> restockUnits repoe stock += qty (reserved INTOCADO), uma unica vez.
    // =========================================================================
    const r1 = runSeam<SeamRestock>("restockUnitsForOrder", { orderId });
    expect(r1.refunded, "refund: CAS reivindica a transicao (refunded===1)").toBe(1);

    const after1 = await client.query<{ stock: number; reserved: number; price_cents: number }>(
      `SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after1.rowCount).toBe(1);
    const prod1 = after1.rows[0];

    // [A1] stock += qty (reposicao); reserved INALTERADO.
    expect(prod1.stock, "[A1] pos-refund: stock = STOCK_AFTER_COMMIT + QTY").toBe(
      STOCK_AFTER_REFUND,
    );
    expect(prod1.reserved, "[A1] pos-refund: reserved INTOCADO (== RES)").toBe(RES);
    expect(prod1.stock - prod0.stock, "delta de stock == +QTY (reposicao unica)").toBe(QTY);
    expect(
      prod1.reserved - prod0.reserved,
      "delta de reserved == 0 (refund nao toca reserved)",
    ).toBe(0);
    expect(prod1.price_cents, "cents-only: price_cents INTOCADO").toBe(PRICE_CENTS);
    expect(Number.isInteger(prod1.stock)).toBe(true);
    expect(Number.isInteger(prod1.reserved)).toBe(true);

    // [A2] Order.stockCommitted virada p/ false via CAS, na MESMA tx do refund;
    //      stockReserved continua false.
    const order1 = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(order1.rows[0].stock_committed, "[A2] pos-refund: Order.stockCommitted=false").toBe(
      false,
    );
    expect(order1.rows[0].stock_reserved, "[A2] stockReserved continua false").toBe(false);

    // =========================================================================
    // [A3] CHECK 0<=reserved<=stock valido (stock cresceu, reserved intacto): na
    // linha alvo E em todo o catalogo.
    // =========================================================================
    expect(prod1.reserved <= prod1.stock, "[A3] na linha alvo: reserved <= stock (7 <= 34)").toBe(
      true,
    );
    expect(prod1.reserved, "[A3] reserved nunca negativo").toBeGreaterThanOrEqual(0);

    const rangeViolations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(
      Number(rangeViolations.rows[0].count),
      "[A3] nenhuma linha viola 0<=reserved<=stock apos o refund",
    ).toBe(0);

    // =========================================================================
    // Reforco de idempotencia (invariante reserve-lifecycle-idempotent): aplicar o
    // refund DE NOVO no MESMO pedido e no-op — o CAS WHERE stock_committed=true agora
    // acha a flag JA virada -> 0 linhas (refunded===0) -> restockUnits NAO roda ->
    // sem dupla reposicao. (Garante que a feature nao repoe estoque em dobro num
    // segundo cancelamento/reconcile — o exato cenario do refund duplicado.)
    // =========================================================================
    const r2 = runSeam<SeamRestock>("restockUnitsForOrder", { orderId });
    expect(r2.refunded, "2a aplicacao e no-op: CAS retorna 0 linhas (refunded===0)").toBe(0);

    const after2 = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after2.rows[0].stock, "apos 2a aplicacao: stock estavel (sem dupla reposicao)").toBe(
      STOCK_AFTER_REFUND,
    );
    expect(after2.rows[0].reserved, "apos 2a aplicacao: reserved AINDA intocado").toBe(RES);

    const order2 = await client.query<{ stock_committed: boolean }>(
      `SELECT stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(order2.rows[0].stock_committed, "flag stockCommitted continua false apos 2a").toBe(
      false,
    );
  } finally {
    await client.end();
  }
});

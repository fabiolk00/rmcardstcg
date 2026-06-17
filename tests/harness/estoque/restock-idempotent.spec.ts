import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.restock.idempotent (priority 15) — DB-first, sem browser.
 *
 * Prova "REPOSICAO DE ESTOQUE (refund) e IDEMPOTENTE: aplicar o refund DE NOVO no
 * MESMO pedido pago NAO repoe estoque em dobro" contra o Postgres efemero REAL
 * exposto em process.env.DATABASE_URL pelo runner (scripts/harness-with-ephemeral-pg.ts).
 * Segue o PADRAO das specs irmas (restock-refund-of-paid.spec.ts /
 * release-idempotent.spec.ts): roda em Node (sem `page`) e assertaa o estado real
 * via `pg`.
 *
 * SEAM escolhida (PRODUCAO, sem mock): o RAMO DE REFUND DE PEDIDO JA PAGO de
 * reconcileStockForPaymentStatus (lib/data/orders.ts L467-473), reproduzido
 * byte-a-byte no runner _run-seam.ts (op "restockUnitsForOrder"). E o caminho que
 * adjustOrderPaymentStatus(orderId,'cancelled',...) dispara via
 * reconcileStockForPaymentStatus quando o CAS de RELEASE nao reivindica (o pedido
 * estava COMMITTED, nao apenas reservado). Numa MESMA $transaction:
 *   (1) le os PROPRIOS itens do pedido (= snap.items na producao);
 *   (2) CAS idempotente do refund:
 *         UPDATE "orders" SET stock_committed=false
 *         WHERE id=? AND stock_committed=true;
 *   (3) SE refunded===1, chama restockUnits REAL (lib/data/inventory) -> stock
 *       += qty; reserved INTOCADO.
 * Nao chamamos a server action direto porque ela exige requireAdmin (contexto de
 * request); a IDEMPOTENCIA desta feature vive inteiramente no CAS da flag
 * stockCommitted + restockUnits, ambos exercitados sem mock. O runner JA suporta a
 * op (sem extensao necessaria).
 *
 * O QUE ESTA SPEC PROVA (asserts do ledger):
 *   [A1] 2a aplicacao no MESMO pedido e no-op: o CAS WHERE stock_committed=true
 *        retorna 0 linhas (refunded===0); restockUnits NAO roda.
 *   [A2] products.stock permanece no valor pos-1a-reposicao (sem dupla reposicao),
 *        apos a 2a E a 3a aplicacao; reserved permanece INTOCADO o tempo todo.
 *   [A3] Order.stockCommitted continua false (flag ja virada pela 1a aplicacao,
 *        nao re-virada nas seguintes).
 * Rede final (invariante reserved-le-stock): CHECK 0<=reserved<=stock valido apos
 * todas as aplicacoes (stock so cresce na 1a; reserved intacto).
 * Invariantes: reserve-lifecycle-idempotent (flag stockCommitted como guard do CAS;
 * 2x/3x = no-op), reserved-le-stock.
 *
 * DADOS PROPRIOS (anti-trivialidade; VALORES DISTINTOS das specs irmas p/ evitar
 * cargo-cult): stock pos-commit STOCK_AFTER_COMMIT=22, reserved RES=9 (>0), qty
 * QTY=6. Apos a 1a reposicao, stock esperado = STOCK_AFTER_COMMIT + QTY = 28, que e:
 *   - != STOCK_AFTER_COMMIT (cresce de verdade na 1a),
 *   - estavel apos 2x/3x — se cada aplicacao repuser, stock iria 28 -> 34 -> 40,
 *     entao a constancia em 28 e um sinal FORTE de idempotencia, nao trivial.
 * reserved=RES(>0) e FORCADO p/ que "reserved inalterado" nao seja trivial (DICA do
 * QA): restockUnits nao toca reserved, entao RES antes == RES depois, com RES>0.
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

const RES = 9; // reserved que NAO pode ser tocado pelo refund (>0, nao trivial)
const STOCK_AFTER_COMMIT = 22; // estoque JA baixado pelo commit (cresce so na 1a reposicao)
const QTY = 6; // unidades do pedido (a repor no estoque pelo refund, uma unica vez)
const PRICE_CENTS = 19990; // cents do produto (deve ficar INTOCADO)
const STOCK_AFTER_REFUND = STOCK_AFTER_COMMIT + QTY; // stock esperado pos-1a-reposicao (28)

test("estoque.restock.idempotent: refund 2x/3x repoe so 1x (CAS no-op, stock estavel sem dupla reposicao, reserved intocado, CHECK valido)", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness RestockIdem ${tag}`;
    const sku = `HARNESS-RESTOCK-IDEM-${tag}`;
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
        stock: 80,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para restock-idempotent",
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
        "Harness RestockIdem",
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
    // 1a aplicacao (o refund legitimo): o CAS de release NAO reivindica (stockReserved
    // ja false), entao cai no CAS de refund WHERE stock_committed=true -> 1 linha
    // (refunded===1) -> restockUnits repoe stock += qty (reserved INTOCADO), uma
    // unica vez.
    // =========================================================================
    const r1 = runSeam<SeamRestock>("restockUnitsForOrder", { orderId });
    expect(r1.refunded, "1a aplicacao: CAS reivindica a transicao (refunded===1)").toBe(1);

    const after1 = await client.query<{ stock: number; reserved: number; price_cents: number }>(
      `SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after1.rowCount).toBe(1);
    const prod1 = after1.rows[0];
    expect(prod1.stock, "pos-1a-reposicao: stock = STOCK_AFTER_COMMIT + QTY").toBe(
      STOCK_AFTER_REFUND,
    );
    expect(prod1.reserved, "pos-1a-reposicao: reserved INTOCADO (== RES)").toBe(RES);
    expect(prod1.stock - prod0.stock, "delta de stock == +QTY (reposicao unica)").toBe(QTY);
    expect(prod1.reserved - prod0.reserved, "delta de reserved == 0").toBe(0);
    expect(prod1.price_cents, "cents-only: price_cents INTOCADO").toBe(PRICE_CENTS);
    expect(Number.isInteger(prod1.stock)).toBe(true);
    expect(Number.isInteger(prod1.reserved)).toBe(true);

    // flag virada p/ false na MESMA tx do refund (guard da idempotencia).
    const order1 = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(order1.rows[0].stock_committed, "pos-1a-reposicao: Order.stockCommitted=false").toBe(
      false,
    );
    expect(order1.rows[0].stock_reserved, "pos-1a-reposicao: stockReserved continua false").toBe(
      false,
    );

    // =========================================================================
    // [A1] 2a aplicacao no MESMO pedido: o CAS WHERE stock_committed=true agora acha
    // a flag JA virada -> 0 linhas (refunded===0) -> restockUnits NAO roda -> sem
    // dupla reposicao. (Garante que a feature nao repoe estoque em dobro num segundo
    // cancelamento/reconcile — o exato cenario do refund duplicado.)
    // =========================================================================
    const r2 = runSeam<SeamRestock>("restockUnitsForOrder", { orderId });
    expect(r2.refunded, "[A1] 2a aplicacao e no-op: CAS retorna 0 linhas (refunded===0)").toBe(0);

    const after2 = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after2.rowCount).toBe(1);
    // [A2] stock permanece no valor pos-1a-reposicao (sem dupla reposicao).
    expect(
      after2.rows[0].stock,
      "[A2] apos 2a aplicacao: stock estavel em STOCK_AFTER_REFUND (sem dupla reposicao)",
    ).toBe(STOCK_AFTER_REFUND);
    expect(after2.rows[0].reserved, "apos 2a aplicacao: reserved AINDA intocado").toBe(RES);

    // [A3] flag stockCommitted continua false apos a 2a (nao re-virada).
    const order2 = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(order2.rows[0].stock_committed, "[A3] stockCommitted continua false apos 2a").toBe(
      false,
    );
    expect(order2.rows[0].stock_reserved, "stockReserved continua false apos 2a").toBe(false);

    // =========================================================================
    // Reforco de idempotencia: 3a aplicacao tambem e no-op. Se houvesse reposicao
    // por aplicacao, stock iria 28 -> 34 -> 40; a constancia em 28 prova que NENHUMA
    // reposicao extra ocorreu.
    // =========================================================================
    const r3 = runSeam<SeamRestock>("restockUnitsForOrder", { orderId });
    expect(r3.refunded, "3a aplicacao tambem e no-op (refunded===0)").toBe(0);

    const after3 = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(
      after3.rows[0].stock,
      "apos 3a aplicacao: stock AINDA estavel em STOCK_AFTER_REFUND",
    ).toBe(STOCK_AFTER_REFUND);
    expect(after3.rows[0].reserved, "apos 3a aplicacao: reserved AINDA intocado").toBe(RES);

    const order3 = await client.query<{ stock_committed: boolean }>(
      `SELECT stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(order3.rows[0].stock_committed, "stockCommitted continua false apos 3a").toBe(false);

    // =========================================================================
    // Rede final (reserved-le-stock): CHECK 0<=reserved<=stock valido apos todas as
    // aplicacoes — na linha alvo E em todo o catalogo.
    // =========================================================================
    expect(
      after3.rows[0].reserved <= after3.rows[0].stock,
      "na linha alvo: reserved <= stock",
    ).toBe(true);
    expect(after3.rows[0].reserved, "reserved nunca negativo").toBeGreaterThanOrEqual(0);

    const rangeViolations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(
      Number(rangeViolations.rows[0].count),
      "nenhuma linha viola 0<=reserved<=stock apos todas as aplicacoes",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

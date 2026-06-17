import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.commit.reserved-to-committed (priority 10) — DB-first, sem browser.
 *
 * Prova "confirmacao de pagamento baixa estoque (reservado -> committed)" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (reserve-reserves-units.spec.ts): roda em Node (sem `page`) e assertaa o estado
 * real via `pg`.
 *
 * SEAM escolhida: commitStock(tx, items) de lib/data/inventory.ts, orquestrada no
 * MESMO compare-and-swap idempotente do ramo 'paid' de reconcileStockForPaymentStatus
 * (orders.ts L448-454). Como commitStock exige o `tx` do chamador, o seam runner
 * (_run-seam.ts, op "commitStockForOrder") abre uma prisma.$transaction e, na MESMA
 * tx: (1) le os PROPRIOS itens do pedido (snap.items na producao); (2) faz o CAS
 *     UPDATE "orders" SET stock_committed=true, stock_reserved=false
 *     WHERE id=? AND stock_reserved=true AND stock_committed=false;
 * (3) SE claimed===1, chama commitStock(tx, lines). E EXATAMENTE o que o webhook/
 * ajuste manual de producao executa ao virar o pedido p/ 'paid'. NAO chamamos
 * adjustOrderPaymentStatus/applyPaymentStatusTx direto porque arrastam verificacao
 * de cobranca Asaas / requireAdmin (contexto de request); o efeito de ESTOQUE
 * (a invariante desta feature) vive inteiramente em commitStock + o CAS das flags.
 *
 * DADOS PROPRIOS (anti-trivialidade): o ledger pede "produto com reserved>=qty e
 * stock>=qty" e baixa de qty. Forcamos stock=20, reserved=R(5)>0 e qty=3 ANTES do
 * commit (via UPDATE direto em `pg`) para que:
 *   - a baixa seja uma SUBTRACAO real em AMBAS as colunas (stock 20->17, reserved
 *     5->2), nao um 0->0 trivial;
 *   - reserved continue > 0 apos a baixa (2), distinto de stock (17), provando que
 *     stock-=qty E reserved-=qty sao efeitos SEPARADOS e ambos ocorreram.
 * reserved e gerido pelo ciclo de reserva (nunca por create/update do produto),
 * entao o UPDATE direto e a forma honesta de pre-posicionar reserved>0.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data/lib/db DIRETO no spec
 * quebra no load. Por isso a MUTACAO (CAS + commitStock dentro de $transaction) roda
 * num processo `tsx` separado (tests/harness/estoque/_run-seam.ts, op
 * "commitStockForOrder"), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: reserve-lifecycle-idempotent (flag stockCommitted/
 * stockReserved via CAS na mesma tx da baixa), reserved-le-stock (CHECK valido apos
 * a baixa).
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type SeamCommit = { claimed: number };

/** Chama uma op do seam via processo tsx; devolve o JSON do __SEAM_RESULT__. */
function runSeam<T>(
  op: "createProduct" | "updateProduct" | "reserveStockForOrder" | "commitStockForOrder",
  payload: unknown,
): T {
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

const R = 5; // reserved inicial (>0; ainda > 0 apos a baixa, p/ tornar o assert nao-trivial)
const STOCK = 20; // estoque fisico antes da baixa
const QTY = 3; // unidades do pedido (a baixar de stock E reserved)
const PRICE_CENTS = 19990; // valor em centavos do produto (deve ficar INTOCADO)

test("estoque.commit.reserved-to-committed: commitStock baixa stock-=qty e reserved-=qty, vira flags, audita-livre", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Commit ${tag}`;
    const sku = `HARNESS-COMMIT-${tag}`;
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
        stock: 50,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para commit-reserved-to-committed",
      },
    });
    const productId = created.id;

    // --- setup B: forca stock=STOCK e reserved=R(>0, e > QTY). reserved e gerido pelo
    //     ciclo de reserva (nunca por create/update do produto); o UPDATE direto e a
    //     forma honesta de pre-posicionar reserved>0. (R <= STOCK respeita o CHECK.)
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK,
      R,
      productId,
    ]);

    const pre = await client.query<{ stock: number; reserved: number; price_cents: number }>(
      `SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    const prod0 = pre.rows[0];
    expect(prod0.stock, "setup deve deixar stock=STOCK").toBe(STOCK);
    expect(prod0.reserved, "setup deve deixar reserved=R (>0, nao trivial)").toBe(R);
    expect(R).toBeGreaterThan(0);
    // Pre-condicao do ledger: reserved>=qty E stock>=qty.
    expect(R, "reserved deve comportar a baixa (reserved >= qty)").toBeGreaterThanOrEqual(QTY);
    expect(STOCK, "stock deve comportar a baixa (stock >= qty)").toBeGreaterThanOrEqual(QTY);
    // Anti-trivialidade: reserved continua > 0 DEPOIS da baixa (R-QTY = 2 > 0).
    expect(R - QTY, "reserved deve sobrar > 0 apos a baixa (distinto de stock)").toBeGreaterThan(0);

    // --- setup C: cria um pedido PROPRIO com 1 item (productId, qty) e flags pre-commit
    //     (stockReserved=true, stockCommitted=false). O commit le os PROPRIOS itens do
    //     pedido (como reconcileStockForPaymentStatus usa snap.items), entao o item real
    //     e quem define as `lines` da baixa.
    const orderIns = await client.query<{ id: number }>(
      `INSERT INTO "orders" (
         clerk_user_id, customer_name, customer_email, customer_phone,
         address_cep, address_street, address_city, address_state,
         subtotal_cents, total_cents, payment_method,
         payment_status, stock_reserved, stock_committed
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', true, false
       ) RETURNING id`,
      [
        `harness-${tag}`,
        "Harness Commit",
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

    // Sanidade do estado pre-commit do pedido.
    const preOrder = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(preOrder.rowCount).toBe(1);
    expect(preOrder.rows[0].stock_reserved, "pre-commit: stockReserved=true").toBe(true);
    expect(preOrder.rows[0].stock_committed, "pre-commit: stockCommitted=false").toBe(false);

    // Conta audit_log inicial deste produto (o createProduct deixou 1) e o total, p/
    // provar que o commit de ESTOQUE nao adultera o audit do produto.
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);

    // --- acao: CAS das flags + commitStock(tx, lines) na MESMA tx (ramo 'paid' do reconcile).
    const commit = runSeam<SeamCommit>("commitStockForOrder", { orderId });

    // --- assert (pre-condicao do efeito): o CAS reivindicou a transicao exatamente 1x.
    expect(commit.claimed, "o CAS deve ter reivindicado a transicao (claimed===1)").toBe(1);

    // --- assert: products.stock -= qty E products.reserved -= qty (baixa definitiva).
    const after = await client.query<{ stock: number; reserved: number; price_cents: number }>(
      `SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount).toBe(1);
    const prod1 = after.rows[0];

    expect(prod1.stock, "stock deve baixar qty (STOCK - QTY)").toBe(STOCK - QTY);
    expect(prod1.reserved, "reserved deve baixar qty (R - QTY)").toBe(R - QTY);
    expect(Number.isInteger(prod1.stock)).toBe(true);
    expect(Number.isInteger(prod1.reserved)).toBe(true);
    // Ambas as colunas baixaram EXATAMENTE qty (efeitos separados, ambos ocorreram).
    expect(prod0.stock - prod1.stock, "delta de stock == QTY").toBe(QTY);
    expect(prod0.reserved - prod1.reserved, "delta de reserved == QTY").toBe(QTY);
    // Anti-trivial: reserved sobrou > 0 e e distinto de stock.
    expect(prod1.reserved, "reserved residual > 0").toBeGreaterThan(0);
    expect(prod1.reserved).not.toBe(prod1.stock);

    // --- assert: Order.stockCommitted == true; Order.stockReserved == false.
    const afterOrder = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(afterOrder.rowCount).toBe(1);
    expect(afterOrder.rows[0].stock_committed, "Order.stockCommitted deve virar true").toBe(true);
    expect(afterOrder.rows[0].stock_reserved, "Order.stockReserved deve virar false").toBe(false);

    // --- assert: CHECK 0<=reserved<=stock continua valido apos a baixa (existe + 0 violacoes).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    // Reforco direto na linha alvo: reserved residual (2) <= novo stock (17).
    expect(prod1.reserved <= prod1.stock, "reserved residual deve permanecer <= novo stock").toBe(
      true,
    );

    // --- assert: valores em centavos INTOCADOS; so quantidades mudam (cents-only nao afetado).
    expect(prod1.price_cents, "price_cents do produto NAO pode mudar na baixa").toBe(PRICE_CENTS);
    expect(prod1.price_cents).toBe(prod0.price_cents);
    expect(Number.isInteger(prod1.price_cents)).toBe(true);
    // O item do pedido (snapshot de centavos) tambem fica intocado pela baixa de quantidade.
    const itemRow = await client.query<{ quantity: number; unit_price_cents: number }>(
      `SELECT quantity, unit_price_cents FROM "order_items" WHERE order_id = $1 AND product_id = $2`,
      [orderId, productId],
    );
    expect(itemRow.rowCount).toBe(1);
    expect(itemRow.rows[0].quantity, "quantity do item permanece QTY").toBe(QTY);
    expect(itemRow.rows[0].unit_price_cents, "unit_price_cents do item intocado").toBe(PRICE_CENTS);
    // Totais do pedido em centavos tambem nao sao tocados pela baixa de estoque.
    const orderCents = await client.query<{ subtotal_cents: number; total_cents: number }>(
      `SELECT subtotal_cents, total_cents FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(orderCents.rows[0].subtotal_cents, "subtotal_cents intocado").toBe(PRICE_CENTS * QTY);
    expect(orderCents.rows[0].total_cents, "total_cents intocado").toBe(PRICE_CENTS * QTY);

    // --- rede final: a baixa de ESTOQUE nao gravou audit no produto (commitStock e
    //     efeito de inventario; o audit do produto e so o product.create do setup).
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    expect(
      Number(afterAudit.rows[0].forEntity),
      "audit do produto inalterado pelo commit de estoque",
    ).toBe(auditForEntityBefore);
    expect(Number(afterAudit.rows[0].total), "audit_log total inalterado pelo commit").toBe(
      auditTotalBefore,
    );
  } finally {
    await client.end();
  }
});

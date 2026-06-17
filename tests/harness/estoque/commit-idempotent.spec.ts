import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.commit.idempotent (priority 11) — DB-first, sem browser.
 *
 * Prova "baixa de estoque e idempotente (commit repetido = no-op)" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (commit-reserved-to-committed.spec.ts): roda em Node (sem `page`) e assertaa o
 * estado real via `pg`.
 *
 * SEAM escolhida: commitStock(tx, items) de lib/data/inventory.ts, orquestrada no
 * MESMO compare-and-swap idempotente do ramo 'paid' de reconcileStockForPaymentStatus
 * (orders.ts L448-454). O seam runner (_run-seam.ts, op "commitStockForOrder" — JA
 * EXISTENTE da sessao 0016, NENHUMA extensao necessaria) abre uma prisma.$transaction
 * e, na MESMA tx: (1) le os PROPRIOS itens do pedido (snap.items na producao); (2) faz
 * o CAS
 *     UPDATE "orders" SET stock_committed=true, stock_reserved=false
 *     WHERE id=? AND stock_reserved=true AND stock_committed=false;
 * (3) SE claimed===1, chama commitStock(tx, lines); devolve { claimed }.
 *
 * A IDEMPOTENCIA e a invariante desta feature: aplicar a conciliacao de 'paid' DUAS
 * vezes no MESMO pedido. A 1a vez reivindica a transicao (claimed===1 -> baixa real).
 * Na 2a vez, as flags ja estao viradas (stock_reserved=false), entao o CAS
 * `WHERE stock_reserved=true AND stock_committed=false` casa 0 linhas (claimed===0):
 * commitStock NAO roda -> SEM dupla baixa. O assert prova exatamente isso lendo o
 * { claimed } das DUAS chamadas e o estado de products/orders entre elas.
 *
 * DADOS PROPRIOS (anti-trivialidade): stock=20, reserved=R(5)>0, qty=3. Apos a 1a
 * baixa stock 20->17 e reserved 5->2 (>0, distinto de stock) — a baixa e SUBTRACAO
 * real em AMBAS as colunas. A 2a chamada deve manter EXATAMENTE 17/2 (se a baixa
 * repetisse, cairia p/ 14/-1, violando o CHECK; provamos que isso NAO acontece).
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
 * Invariantes cobertas: reserve-lifecycle-idempotent (CAS das flags garante que a
 * 2a aplicacao e no-op, sem dupla baixa), reserved-le-stock (CHECK valido apos cada
 * aplicacao; reserved nunca fica negativo).
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
const QTY = 3; // unidades do pedido (a baixar de stock E reserved UMA UNICA VEZ)
const PRICE_CENTS = 19990; // valor em centavos do produto (deve ficar INTOCADO)

test("estoque.commit.idempotent: 2a aplicacao do commit e no-op (CAS=0), sem dupla baixa", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness CommitIdem ${tag}`;
    const sku = `HARNESS-COMMITIDEM-${tag}`;
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
        description: "fixture do harness para commit-idempotent",
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
    expect(R, "reserved deve comportar a baixa (reserved >= qty)").toBeGreaterThanOrEqual(QTY);
    expect(STOCK, "stock deve comportar a baixa (stock >= qty)").toBeGreaterThanOrEqual(QTY);
    expect(R - QTY, "reserved deve sobrar > 0 apos a baixa (distinto de stock)").toBeGreaterThan(0);

    // --- setup C: cria um pedido PROPRIO com 1 item (productId, qty) e flags pre-commit
    //     (stockReserved=true, stockCommitted=false).
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
        "Harness CommitIdem",
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

    // ===================================================================
    // 1a APLICACAO — reivindica a transicao (claimed===1), baixa real.
    // ===================================================================
    const commit1 = runSeam<SeamCommit>("commitStockForOrder", { orderId });
    expect(commit1.claimed, "1a aplicacao: CAS reivindica a transicao (claimed===1)").toBe(1);

    const afterFirst = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(afterFirst.rowCount).toBe(1);
    const prod1 = afterFirst.rows[0];
    // Baixa real: stock 20->17, reserved 5->2 (subtracao em AMBAS as colunas).
    expect(prod1.stock, "1a baixa: stock = STOCK - QTY").toBe(STOCK - QTY);
    expect(prod1.reserved, "1a baixa: reserved = R - QTY").toBe(R - QTY);
    expect(prod0.stock - prod1.stock, "1a baixa: delta stock == QTY").toBe(QTY);
    expect(prod0.reserved - prod1.reserved, "1a baixa: delta reserved == QTY").toBe(QTY);
    // Anti-trivial: reserved residual > 0 e distinto do novo stock (uma 2a baixa o
    // levaria a -1, violando o CHECK; provamos que ele FICA em 2).
    expect(prod1.reserved, "reserved residual > 0 (uma 2a baixa o tornaria negativo)").toBe(2);
    expect(prod1.reserved).not.toBe(prod1.stock);

    // Flags viradas pela 1a aplicacao.
    const orderAfterFirst = await client.query<{
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [orderId]);
    expect(orderAfterFirst.rows[0].stock_committed, "1a: stockCommitted=true").toBe(true);
    expect(orderAfterFirst.rows[0].stock_reserved, "1a: stockReserved=false").toBe(false);

    // ===================================================================
    // 2a APLICACAO — MESMO pedido, conciliacao de 'paid' de novo.
    // ===================================================================
    const commit2 = runSeam<SeamCommit>("commitStockForOrder", { orderId });

    // --- assert (ledger 1): a 2a aplicacao e NO-OP. O CAS
    //     WHERE stock_reserved=true AND stock_committed=false casa 0 linhas (claimed===0)
    //     porque a 1a aplicacao ja virou stock_reserved=false; commitStock NAO roda.
    expect(commit2.claimed, "2a aplicacao: CAS retorna 0 linhas (claimed===0) -> no-op").toBe(0);

    // --- assert (ledger 2): products.stock e reserved permanecem nos valores
    //     pos-primeira-baixa (sem dupla baixa).
    const afterSecond = await client.query<{
      stock: number;
      reserved: number;
      price_cents: number;
    }>(`SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`, [productId]);
    expect(afterSecond.rowCount).toBe(1);
    const prod2 = afterSecond.rows[0];
    expect(prod2.stock, "2a aplicacao NAO baixa de novo: stock == pos-1a (17)").toBe(prod1.stock);
    expect(prod2.reserved, "2a aplicacao NAO baixa de novo: reserved == pos-1a (2)").toBe(
      prod1.reserved,
    );
    // Reforco explicito contra dupla baixa: jamais o estado 14/-1.
    expect(prod2.stock, "stock total baixou exatamente UMA vez QTY").toBe(STOCK - QTY);
    expect(prod2.reserved, "reserved total baixou exatamente UMA vez QTY").toBe(R - QTY);
    expect(Number.isInteger(prod2.stock)).toBe(true);
    expect(Number.isInteger(prod2.reserved)).toBe(true);

    // --- assert (ledger 3): Order.stockCommitted continua true; stockReserved continua false.
    const orderAfterSecond = await client.query<{
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [orderId]);
    expect(orderAfterSecond.rowCount).toBe(1);
    expect(orderAfterSecond.rows[0].stock_committed, "2a: stockCommitted continua true").toBe(true);
    expect(orderAfterSecond.rows[0].stock_reserved, "2a: stockReserved continua false").toBe(false);

    // --- invariante reserved-le-stock: CHECK existe + 0 violacoes (reserved nunca
    //     negativo; uma 2a baixa teria deixado reserved=-1).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    expect(prod2.reserved >= 0, "reserved nunca fica negativo").toBe(true);
    expect(prod2.reserved <= prod2.stock, "reserved <= stock apos as duas aplicacoes").toBe(true);

    // --- rede final: centavos intocados; o commit de ESTOQUE (idempotente) nunca
    //     mexe em valores monetarios, so quantidades de inventario.
    expect(prod2.price_cents, "price_cents intocado").toBe(PRICE_CENTS);
    expect(Number.isInteger(prod2.price_cents)).toBe(true);
  } finally {
    await client.end();
  }
});

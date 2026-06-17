import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.reserve.reserves-units (priority 8) — DB-first, sem browser.
 *
 * Prova "reserva de estoque incrementa reserved e marca stockReserved" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (product-reduce-stock-above-reserved.spec.ts): roda em Node (sem `page`) e
 * assertaa o estado real via `pg`.
 *
 * SEAM escolhida: reserveStock(tx, items) de lib/data/inventory.ts — a funcao de
 * PRODUCAO que reserva (reserved += qty SE stock-reserved >= qty, atomica e
 * condicional, em LOTE via $queryRaw). Como ela exige o `tx` da transacao do
 * chamador, o seam runner (_run-seam.ts, op "reserveStockForOrder") abre uma
 * prisma.$transaction e, na MESMA tx, chama reserveStock E vira a flag
 * Order.stockReserved=true (stockCommitted=false) — EXATAMENTE o que o checkout de
 * producao faz (createPendingOrderWithReservation, orders.ts L193-221:
 * reserveStock(tx, ...) seguido de tx.order.create({ stockReserved:true })). Aqui
 * usamos um pedido pre-criado e fazemos tx.order.update das flags, mas o seam
 * (reserveStock + flag na mesma tx) e o de producao, sem mock.
 *
 * DADOS PROPRIOS (anti-trivialidade): o ledger pede "Le reserved=R de um produto
 * com disponibilidade". Forcamos R(2)>0 e stock(20) ANTES da reserva (via UPDATE
 * direto em `pg`) para que:
 *   - o incremento R -> R+3 seja uma SOMA real (nao 0 -> 3 trivial);
 *   - haja disponibilidade de sobra (stock-reserved = 18 >= 3) para a reserva passar;
 *   - "stock inalterado" seja distinto de "reserved inalterado".
 * reserved e gerido pelo ciclo de reserva (nunca por create/update do produto),
 * entao o UPDATE direto e a forma honesta de pre-posicionar reserved>0.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data/lib/db DIRETO no spec
 * quebra no load. Por isso a MUTACAO (reserveStock dentro de $transaction) roda num
 * processo `tsx` separado (tests/harness/estoque/_run-seam.ts), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: reserved-le-stock, reserve-lifecycle-idempotent (marca
 * Order.stockReserved=true / stockCommitted=false na mesma tx da reserva).
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type SeamReserve = { ok: true } | { ok: false; productId: string };

/** Chama uma op do seam via processo tsx; devolve o JSON do __SEAM_RESULT__. */
function runSeam<T>(
  op: "createProduct" | "updateProduct" | "reserveStockForOrder",
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

const R = 2; // reserved inicial (>0, p/ tornar o incremento uma soma real)
const STOCK = 20; // estoque fisico (alto p/ haver disponibilidade de sobra)
const QTY = 3; // unidades a reservar

test("estoque.reserve.reserves-units: reserveStock soma reserved=R+3, stock inalterado, marca stockReserved", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Reserve ${tag}`;
    const sku = `HARNESS-RESERVE-${tag}`;
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup A: cria um produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor,
      input: {
        name,
        category: "Booster Box",
        sku,
        priceCents: 19990,
        discountPct: 0,
        stock: 50,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para reserve-reserves-units",
      },
    });
    const productId = created.id;

    // --- setup B: forca stock=STOCK e reserved=R(>0). reserved e gerido pelo ciclo
    //     de reserva (nunca por create/update do produto); o UPDATE direto e a forma
    //     honesta de pre-posicionar reserved>0. (R <= STOCK respeita o CHECK.)
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK,
      R,
      productId,
    ]);

    const pre = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    expect(pre.rows[0].stock, "setup deve deixar stock=STOCK").toBe(STOCK);
    expect(pre.rows[0].reserved, "setup deve deixar reserved=R (>0, nao trivial)").toBe(R);
    expect(R).toBeGreaterThan(0);
    // Disponibilidade de sobra: stock - reserved deve comportar a reserva de QTY.
    expect(STOCK - R, "deve haver disponibilidade >= QTY").toBeGreaterThanOrEqual(QTY);

    // --- setup C: cria um pedido PROPRIO com stockReserved=false (estado pre-reserva).
    //     So as colunas NOT NULL sem default precisam ser fornecidas; o resto usa
    //     default (payment_status=pending, stock_reserved=false, etc.).
    const orderIns = await client.query<{ id: number }>(
      `INSERT INTO "orders" (
         clerk_user_id, customer_name, customer_email, customer_phone,
         address_cep, address_street, address_city, address_state,
         subtotal_cents, total_cents, payment_method
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       ) RETURNING id`,
      [
        `harness-${tag}`,
        "Harness Reserve",
        "harness@example.com",
        "(41) 90000-0000",
        "80000-000",
        "Rua Teste",
        "Curitiba",
        "PR",
        19990,
        19990,
        "PIX",
      ],
    );
    expect(orderIns.rowCount).toBe(1);
    const orderId = orderIns.rows[0].id;

    // Sanidade do estado pre-reserva do pedido.
    const preOrder = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(preOrder.rowCount).toBe(1);
    expect(preOrder.rows[0].stock_reserved, "pedido novo nasce stockReserved=false").toBe(false);
    expect(preOrder.rows[0].stock_committed, "pedido novo nasce stockCommitted=false").toBe(false);

    // --- acao: reserveStock(tx, [{productId, quantity:3}]) + flag do pedido na MESMA tx.
    const reserve = runSeam<SeamReserve>("reserveStockForOrder", {
      orderId,
      items: [{ productId, quantity: QTY }],
    });

    // --- assert: reserveStock retorna {ok:true}.
    expect(reserve.ok, "reserveStock deve retornar ok:true (havia disponibilidade)").toBe(true);

    // --- assert: products.reserved == R+QTY; products.stock inalterado (reserva
    //     NAO baixa estoque fisico).
    const after = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount).toBe(1);
    const p1 = after.rows[0];
    expect(p1.reserved, "reserved deve subir para R+QTY").toBe(R + QTY);
    expect(Number.isInteger(p1.reserved)).toBe(true);
    expect(p1.stock, "stock fisico NAO muda na reserva").toBe(STOCK);
    // Incremento foi uma SOMA real (R era > 0), nao um 0 -> QTY trivial.
    expect(p1.reserved - R, "delta de reserved == QTY").toBe(QTY);

    // --- assert: Order.stockReserved == true; Order.stockCommitted == false.
    const afterOrder = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(afterOrder.rowCount).toBe(1);
    expect(afterOrder.rows[0].stock_reserved, "Order.stockReserved deve virar true").toBe(true);
    expect(afterOrder.rows[0].stock_committed, "Order.stockCommitted deve continuar false").toBe(
      false,
    );

    // --- assert: CHECK 0<=reserved<=stock valido (R+QTY <= stock) — existe + 0 violacoes.
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    // Reforco na linha alvo: R+QTY (5) <= stock (20).
    expect(p1.reserved <= p1.stock, "reserved (R+QTY) deve permanecer <= stock").toBe(true);
    expect(p1.reserved).toBe(R + QTY);
    expect(p1.stock).toBe(STOCK);

    // --- defesa em profundidade: o DB rejeita reserved > stock por SQL cru, provando
    //     que a invariante e do BANCO (nao so da funcao). reserved=STOCK+1 e barrado.
    let dbRejected = false;
    try {
      await client.query(`UPDATE "products" SET reserved = $1 WHERE id = $2`, [
        STOCK + 1,
        productId,
      ]);
    } catch (e) {
      dbRejected = true;
      expect(String((e as Error).message)).toMatch(/products_reserved_le_stock_chk/);
    }
    expect(dbRejected, "DB deve rejeitar reserved > stock (oversell) por SQL cru").toBe(true);
    // E a linha permanece nos valores pos-reserva (o UPDATE invalido nao persistiu).
    const finalRow = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(finalRow.rows[0].reserved, "UPDATE invalido nao persiste reserved").toBe(R + QTY);
    expect(finalRow.rows[0].stock).toBe(STOCK);
  } finally {
    await client.end();
  }
});

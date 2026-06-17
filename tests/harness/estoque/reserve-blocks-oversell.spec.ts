import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.reserve.blocks-oversell (priority 9) — DB-first, sem browser.
 *
 * Prova "reserva alem do disponivel falha sem efeito parcial" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO da spec irma
 * (reserve-reserves-units.spec.ts): roda em Node (sem `page`) e assertaa o estado
 * real via `pg`.
 *
 * SEAM escolhida: reserveStock(tx, items) de lib/data/inventory.ts — a funcao de
 * PRODUCAO que reserva (reserved += qty SE stock-reserved >= qty, atomica e
 * condicional, em LOTE via $queryRaw; L62-82). O guard `p.stock - p.reserved >= v.qty`
 * vale por linha DENTRO do mesmo UPDATE: a linha que NAO cabe simplesmente nao e
 * atualizada, e como updated.length (0) != rows.length (1), a funcao retorna
 * { ok:false, productId } do produto sem disponibilidade.
 *
 * O seam runner (_run-seam.ts, op "reserveStockForOrder") abre uma
 * prisma.$transaction e, na MESMA tx, chama reserveStock; ao receber ok:false ele
 * lanca ReserveAbort -> ROLLBACK total da transacao, EXATAMENTE como o checkout de
 * producao faz com OutOfStockError (createPendingOrderWithReservation). O resultado
 * { ok:false, productId } e re-emitido como __SEAM_RESULT__ apos o rollback, para a
 * spec inspecionar { ok:false } E provar que NADA foi gravado (reserva nem flag).
 * Nenhuma extensao de runner foi necessaria (reserveStockForOrder ja existe).
 *
 * DADOS PROPRIOS (anti-trivialidade): o ledger pede stock=5, reserved=4
 * (disponivel=1) e pede 2 (so ha 1). Forcamos esses valores ANTES da reserva (via
 * UPDATE direto em `pg`) para que:
 *   - reserved(4)>0: a invariante "reserved permanece 4" e uma SOMA nao-trivial
 *     (nao 0 -> 0), provando que NAO houve incremento parcial mesmo partindo de >0;
 *   - disponivel(1) seja ESTRITAMENTE MENOR que o pedido(2): o guard falha de fato;
 *   - a falta seja de exatamente 1 unidade (borda apertada), nao trivialmente grande.
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
 * Invariantes cobertas: reserved-le-stock (o oversell e impossivel: nem a funcao
 * incrementa, nem o DB aceitaria reserved>stock), reserve-lifecycle-idempotent
 * (sem efeito parcial; a flag Order.stockReserved permanece false apos o rollback).
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

const STOCK = 5; // estoque fisico
const RESERVED = 4; // reserved inicial (>0): disponivel = stock - reserved = 1
const QTY = 2; // unidades pedidas (> disponivel: pede 2, so ha 1)

test("estoque.reserve.blocks-oversell: reserveStock retorna ok:false sem incremento parcial; rollback nao grava nada", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Oversell ${tag}`;
    const sku = `HARNESS-OVERSELL-${tag}`;
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
        description: "fixture do harness para reserve-blocks-oversell",
      },
    });
    const productId = created.id;

    // --- setup B: forca stock=5, reserved=4 (disponivel=1). reserved e gerido pelo
    //     ciclo de reserva (nunca por create/update do produto); o UPDATE direto e a
    //     forma honesta de pre-posicionar reserved>0. (4 <= 5 respeita o CHECK.)
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK,
      RESERVED,
      productId,
    ]);

    const pre = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    expect(pre.rows[0].stock, "setup deve deixar stock=5").toBe(STOCK);
    expect(pre.rows[0].reserved, "setup deve deixar reserved=4 (>0, nao trivial)").toBe(RESERVED);
    expect(RESERVED).toBeGreaterThan(0);
    // Disponibilidade ESTRITAMENTE menor que o pedido: disponivel(1) < QTY(2).
    const available = STOCK - RESERVED;
    expect(available, "disponivel = stock - reserved deve ser 1").toBe(1);
    expect(available, "o pedido (QTY) deve exceder o disponivel (oversell)").toBeLessThan(QTY);

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
        "Harness Oversell",
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

    // --- acao: reserveStock(tx, [{productId, quantity:2}]) (pede 2, so ha 1). O seam
    //     abre a tx, chama reserveStock, recebe ok:false e ABORTA (rollback total),
    //     exatamente como o checkout faz com OutOfStockError. O resultado cru e
    //     re-emitido apos o rollback p/ inspecao.
    const reserve = runSeam<SeamReserve>("reserveStockForOrder", {
      orderId,
      items: [{ productId, quantity: QTY }],
    });

    // --- assert [1]: reserveStock retorna {ok:false, productId} apontando o produto
    //     sem disponibilidade. (productId real do input, nao generico.)
    expect(reserve.ok, "reserveStock deve retornar ok:false (sem disponibilidade)").toBe(false);
    if (reserve.ok) throw new Error("inalcancavel: ok deveria ser false");
    expect(reserve.productId, "ok:false deve apontar o productId solicitado").toBe(productId);

    // --- assert [2]: products.reserved permanece 4 (nenhum incremento parcial) e
    //     products.stock permanece 5 (reserva nem comecou a baixar). A leitura crua
    //     via `pg` ja roda fora da tx abortada, entao prova que o rollback valeu.
    const after = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount).toBe(1);
    const p1 = after.rows[0];
    expect(p1.reserved, "reserved NAO muda (sem incremento parcial)").toBe(RESERVED);
    expect(p1.stock, "stock NAO muda").toBe(STOCK);
    expect(Number.isInteger(p1.reserved)).toBe(true);
    // Reforco: o delta e ZERO (nem 1 unidade parcial entrou).
    expect(p1.reserved - RESERVED, "delta de reserved deve ser 0 (nada reservado)").toBe(0);

    // --- assert [3]: chamador abortou a transacao; NADA gravado. A flag do pedido
    //     permanece false (a tx.order.update das flags so roda no ramo ok:true, que
    //     nem foi alcancado; e o rollback descartaria mesmo se tivesse rodado).
    const afterOrder = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(afterOrder.rowCount).toBe(1);
    expect(
      afterOrder.rows[0].stock_reserved,
      "Order.stockReserved permanece false (rollback)",
    ).toBe(false);
    expect(
      afterOrder.rows[0].stock_committed,
      "Order.stockCommitted permanece false (rollback)",
    ).toBe(false);

    // --- assert [4]: CHECK 0<=reserved<=stock jamais violado — existe + 0 violacoes.
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    // Reforco na linha alvo: reserved(4) <= stock(5); o estado proibido reserved>stock
    // (que existiria se o oversell de 4+2=6 > 5 tivesse persistido) jamais ocorreu.
    expect(p1.reserved <= p1.stock, "reserved deve permanecer <= stock").toBe(true);
    expect(RESERVED + QTY, "o oversell hipotetico (6) excederia o stock (5)").toBeGreaterThan(
      STOCK,
    );

    // --- defesa em profundidade: o DB rejeita reserved > stock por SQL cru, provando
    //     que a invariante e do BANCO (nao so da funcao). reserved=6 (o que o oversell
    //     teria produzido) e barrado pelo CHECK products_reserved_le_stock_chk.
    let dbRejected = false;
    try {
      await client.query(`UPDATE "products" SET reserved = $1 WHERE id = $2`, [
        RESERVED + QTY, // 6 > stock(5) — o estado que o oversell criaria
        productId,
      ]);
    } catch (e) {
      dbRejected = true;
      expect(String((e as Error).message)).toMatch(/products_reserved_le_stock_chk/);
    }
    expect(dbRejected, "DB deve rejeitar reserved > stock (oversell) por SQL cru").toBe(true);
    // E a linha permanece nos valores pre-reserva (o UPDATE invalido nao persistiu).
    const finalRow = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(finalRow.rows[0].reserved, "UPDATE invalido nao persiste reserved").toBe(RESERVED);
    expect(finalRow.rows[0].stock).toBe(STOCK);
  } finally {
    await client.end();
  }
});

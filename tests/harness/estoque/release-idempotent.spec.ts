import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.release.idempotent (priority 13) — DB-first, sem browser.
 *
 * Prova "estorno de reserva e IDEMPOTENTE: cancelar um pedido pendente 2x (e 3x)
 * NAO estorna em dobro" contra o Postgres efemero REAL exposto em
 * process.env.DATABASE_URL pelo runner (scripts/harness-with-ephemeral-pg.ts).
 * Segue o PADRAO das specs irmas (release-reserved-on-cancel.spec.ts): roda em
 * Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida (PRODUCAO, sem mock): o ramo 'cancelled'->release de
 * reconcileStockForPaymentStatus (lib/data/orders.ts L457-466), reproduzido
 * byte-a-byte no runner _run-seam.ts (op "releaseStockForOrder"). Numa MESMA
 * $transaction:
 *   (1) le os PROPRIOS itens do pedido (= snap.items na producao);
 *   (2) CAS idempotente:
 *         UPDATE "orders" SET stock_reserved=false
 *         WHERE id=? AND stock_reserved=true AND stock_committed=false;
 *   (3) SE released===1, chama releaseStock REAL (lib/data/inventory) -> reserved
 *       -= qty; stock INTOCADO.
 * Este e EXATAMENTE o efeito que adjustOrderPaymentStatus(orderId,'cancelled',...)
 * dispara via reconcileStockForPaymentStatus. Nao chamamos a server action direto
 * porque ela exige requireAdmin (contexto de request); a IDEMPOTENCIA desta feature
 * vive inteiramente no CAS das flags + releaseStock, ambos exercitados sem mock. O
 * runner JA suporta a op (sem extensao necessaria).
 *
 * O QUE ESTA SPEC PROVA (asserts do ledger):
 *   [A1] 2a aplicacao no MESMO pedido e no-op: o CAS retorna 0 linhas (released===0).
 *   [A2] products.reserved permanece no valor pos-1o-estorno (sem decremento duplo),
 *        apos a 2a E a 3a aplicacao.
 *   [A3] CHECK reserved>=0 jamais violado (products_reserved_nonneg_chk presente;
 *        0 violacoes; reserved residual >= 0) — e tambem reserved<=stock
 *        (products_reserved_le_stock_chk), invariante reserved-le-stock.
 * Invariantes: reserve-lifecycle-idempotent (flag stockReserved como guard do CAS;
 * 2x/3x = no-op), reserved-le-stock.
 *
 * DADOS PROPRIOS (anti-trivialidade; VALORES DISTINTOS da spec irma p/ evitar
 * colisao/cargo-cult): stock=40, reserved inicial RES=11 (>0), qty=QTY=5. Apos o
 * 1o estorno, reserved esperado = RES-QTY = 6, que e:
 *   - > 0 (prova que so qty saiu, nao zerou),
 *   - != stock (40),
 *   - != 0 (se a 2a aplicacao decrementasse em dobro, cairia p/ 1; um 3o
 *     decremento p/ -4 ESTOURARIA o CHECK nonneg — exatamente o que a idempotencia
 *     impede). Assim a constancia de reserved=6 apos 2x/3x e um sinal FORTE, nao
 *     trivial.
 * reserved e gerido pelo ciclo de reserva (nunca por create/update do produto),
 * entao o UPDATE direto e a forma honesta de pre-posicionar reserved>0.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * p/ CJS, onde import.meta = SyntaxError — importar lib/data/lib/db DIRETO no spec
 * quebra no load. Por isso a MUTACAO (CAS + releaseStock dentro de $transaction)
 * roda num processo `tsx` separado (_run-seam.ts, op "releaseStockForOrder"),
 * herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type SeamRelease = { released: number };

/** Chama uma op do seam via processo tsx; devolve o JSON do __SEAM_RESULT__. */
function runSeam<T>(
  op: "createProduct" | "updateProduct" | "reserveStockForOrder" | "releaseStockForOrder",
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

const RES = 11; // reserved inicial (>0; > QTY; ainda > 0 apos o 1o estorno)
const STOCK = 40; // estoque fisico (deve ficar INTOCADO pelo estorno)
const QTY = 5; // unidades do pedido (a estornar de reserved UMA unica vez)
const PRICE_CENTS = 12990; // cents do produto (deve ficar INTOCADO)
const RES_AFTER = RES - QTY; // reserved esperado apos QUALQUER numero de aplicacoes (6)

test("estoque.release.idempotent: cancelar pendente 2x/3x estorna so 1x (CAS no-op, reserved estavel, CHECK reserved>=0 intacto)", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness ReleaseIdem ${tag}`;
    const sku = `HARNESS-RELEASE-IDEM-${tag}`;
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
        stock: 60,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para release-idempotent",
      },
    });
    const productId = created.id;

    // --- setup B: forca stock=STOCK e reserved=RES(>0, > QTY). reserved e gerido pelo
    //     ciclo de reserva (nunca por create/update); UPDATE direto e a forma honesta
    //     de pre-posicionar reserved>0. RES <= STOCK respeita o CHECK.
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK,
      RES,
      productId,
    ]);

    const pre = await client.query<{ stock: number; reserved: number; price_cents: number }>(
      `SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    const prod0 = pre.rows[0];
    expect(prod0.stock, "setup deve deixar stock=STOCK").toBe(STOCK);
    expect(prod0.reserved, "setup deve deixar reserved=RES (>0, nao trivial)").toBe(RES);
    expect(RES).toBeGreaterThan(0);
    expect(RES, "reserved deve comportar o estorno (reserved >= qty)").toBeGreaterThanOrEqual(QTY);
    expect(RES_AFTER, "reserved deve sobrar > 0 apos o estorno (nao trivial)").toBeGreaterThan(0);

    // --- setup C: cria um pedido PROPRIO PENDENTE com 1 item (productId, qty) e flags
    //     de reserva ativa (stockReserved=true, stockCommitted=false). O estorno le os
    //     PROPRIOS itens do pedido (como reconcileStockForPaymentStatus usa snap.items).
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
        "Harness ReleaseIdem",
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

    // Sanidade pre-cancelamento: reserva ativa, nao committed.
    const preOrder = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(preOrder.rowCount).toBe(1);
    expect(preOrder.rows[0].stock_reserved, "pre-cancel: stockReserved=true").toBe(true);
    expect(preOrder.rows[0].stock_committed, "pre-cancel: stockCommitted=false").toBe(false);

    // Sanidade: AMBOS os CHECKs do ciclo de reserva existem (nonneg + le_stock).
    const checks = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
         WHERE conname IN ('products_reserved_nonneg_chk', 'products_reserved_le_stock_chk')`,
    );
    const haveChecks = new Set(checks.rows.map((r) => r.conname));
    expect(haveChecks.has("products_reserved_nonneg_chk"), "CHECK reserved>=0 deve existir").toBe(
      true,
    );
    expect(
      haveChecks.has("products_reserved_le_stock_chk"),
      "CHECK reserved<=stock deve existir",
    ).toBe(true);

    // =========================================================================
    // 1a aplicacao (o estorno legitimo): CAS reivindica a transicao (released===1)
    // e releaseStock decrementa reserved EXATAMENTE qty, uma unica vez.
    // =========================================================================
    const r1 = runSeam<SeamRelease>("releaseStockForOrder", { orderId });
    expect(r1.released, "1a aplicacao: CAS reivindica a transicao (released===1)").toBe(1);

    const after1 = await client.query<{ stock: number; reserved: number; price_cents: number }>(
      `SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after1.rowCount).toBe(1);
    const prod1 = after1.rows[0];
    expect(prod1.reserved, "pos-1o-estorno: reserved = RES - QTY").toBe(RES_AFTER);
    expect(prod1.stock, "pos-1o-estorno: stock fisico INTOCADO").toBe(STOCK);
    expect(prod0.reserved - prod1.reserved, "delta de reserved == QTY (estorno unico)").toBe(QTY);
    expect(prod0.stock - prod1.stock, "delta de stock == 0").toBe(0);
    expect(prod1.price_cents, "cents-only: price_cents INTOCADO").toBe(PRICE_CENTS);
    expect(Number.isInteger(prod1.reserved)).toBe(true);

    // flag virada p/ false na MESMA tx do estorno (guard da idempotencia).
    const order1 = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(order1.rows[0].stock_reserved, "pos-1o-estorno: Order.stockReserved=false").toBe(false);
    expect(order1.rows[0].stock_committed, "pos-1o-estorno: stockCommitted continua false").toBe(
      false,
    );

    // =========================================================================
    // [A1] 2a aplicacao no MESMO pedido: o CAS WHERE stock_reserved=true AND
    // stock_committed=false agora acha a flag JA virada -> 0 linhas (released===0)
    // -> releaseStock NAO roda -> sem decremento duplo.
    // =========================================================================
    const r2 = runSeam<SeamRelease>("releaseStockForOrder", { orderId });
    expect(r2.released, "[A1] 2a aplicacao e no-op: CAS retorna 0 linhas (released===0)").toBe(0);

    const after2 = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after2.rowCount).toBe(1);
    // [A2] reserved permanece no valor pos-1o-estorno (sem decremento duplo).
    expect(after2.rows[0].reserved, "[A2] apos 2a aplicacao: reserved estavel em RES-QTY").toBe(
      RES_AFTER,
    );
    expect(after2.rows[0].stock, "apos 2a aplicacao: stock estavel em STOCK").toBe(STOCK);

    const order2 = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(order2.rows[0].stock_reserved, "flag continua false apos 2a aplicacao").toBe(false);
    expect(order2.rows[0].stock_committed, "stockCommitted continua false").toBe(false);

    // =========================================================================
    // Reforco de idempotencia: 3a aplicacao tambem e no-op. Se houvesse decremento
    // por aplicacao, reserved iria 6 -> 1 -> -4, e o -4 ESTOURARIA o CHECK nonneg.
    // A constancia em 6 prova que NENHUM estorno extra ocorreu.
    // =========================================================================
    const r3 = runSeam<SeamRelease>("releaseStockForOrder", { orderId });
    expect(r3.released, "3a aplicacao tambem e no-op (released===0)").toBe(0);

    const after3 = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after3.rows[0].reserved, "apos 3a aplicacao: reserved AINDA estavel em RES-QTY").toBe(
      RES_AFTER,
    );
    expect(after3.rows[0].stock, "apos 3a aplicacao: stock AINDA estavel em STOCK").toBe(STOCK);

    // =========================================================================
    // [A3] CHECK reserved>=0 jamais violado (e reserved<=stock — reserved-le-stock).
    // Asserta na linha alvo E em todo o catalogo, apos todas as aplicacoes.
    // =========================================================================
    expect(after3.rows[0].reserved, "[A3] reserved residual nunca negativo").toBeGreaterThanOrEqual(
      0,
    );
    expect(
      after3.rows[0].reserved <= after3.rows[0].stock,
      "reserved residual permanece <= stock (reserved-le-stock)",
    ).toBe(true);

    const nonnegViolations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products" WHERE NOT (reserved >= 0)`,
    );
    expect(
      Number(nonnegViolations.rows[0].count),
      "[A3] nenhuma linha viola reserved>=0 apos todas as aplicacoes",
    ).toBe(0);

    const rangeViolations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(
      Number(rangeViolations.rows[0].count),
      "nenhuma linha viola 0<=reserved<=stock apos todas as aplicacoes",
    ).toBe(0);

    // =========================================================================
    // PROVA DB-ENFORCED do CHECK nonneg: um decremento "em dobro" alem do legitimo
    // (reserved -> negativo) e REJEITADO pelo Postgres. Faz num SAVEPOINT e
    // desfaz, p/ nao sujar o estado. Demonstra que a idempotencia nao e a unica
    // rede: mesmo se o CAS falhasse, o DB barraria o reserved negativo.
    // =========================================================================
    await client.query("BEGIN");
    await client.query("SAVEPOINT chk_probe");
    let rejected = false;
    try {
      // RES_AFTER (6) - (RES_AFTER + 1) = -1 -> deve estourar products_reserved_nonneg_chk.
      await client.query(`UPDATE "products" SET reserved = reserved - $1 WHERE id = $2`, [
        RES_AFTER + 1,
        productId,
      ]);
    } catch (e) {
      rejected = true;
      expect(String((e as Error).message)).toContain("products_reserved_nonneg_chk");
    }
    await client.query("ROLLBACK TO SAVEPOINT chk_probe");
    await client.query("ROLLBACK");
    expect(rejected, "DB rejeita reserved negativo (CHECK products_reserved_nonneg_chk)").toBe(
      true,
    );

    // Estado preservado apos a probe (rollback do savepoint nao alterou nada).
    const afterProbe = await client.query<{ reserved: number; stock: number }>(
      `SELECT reserved, stock FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(afterProbe.rows[0].reserved, "reserved intacto apos a probe DB-enforced").toBe(
      RES_AFTER,
    );
    expect(afterProbe.rows[0].stock, "stock intacto apos a probe DB-enforced").toBe(STOCK);
  } finally {
    await client.end();
  }
});

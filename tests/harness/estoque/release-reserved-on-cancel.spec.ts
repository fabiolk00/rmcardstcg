import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.release.reserved-on-cancel (priority 12) — DB-first, sem browser.
 *
 * Prova "cancelar pedido pendente estorna a reserva" contra o Postgres efemero
 * REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (commit-reserved-to-committed.spec.ts): roda em Node (sem `page`) e assertaa o
 * estado real via `pg`.
 *
 * SEAM escolhida: releaseStock(tx, items) de lib/data/inventory.ts, orquestrada no
 * MESMO compare-and-swap idempotente do ramo 'cancelled'->release de
 * reconcileStockForPaymentStatus (orders.ts L457-466). Como releaseStock exige o
 * `tx` do chamador, o seam runner (_run-seam.ts, op "releaseStockForOrder") abre
 * uma prisma.$transaction e, na MESMA tx: (1) le os PROPRIOS itens do pedido
 * (snap.items na producao); (2) faz o CAS
 *     UPDATE "orders" SET stock_reserved=false
 *     WHERE id=? AND stock_reserved=true AND stock_committed=false;
 * (3) SE released===1, chama releaseStock(tx, lines) (reserved -= qty; stock
 * INTOCADO). E EXATAMENTE o que adjustOrderPaymentStatus(orderId, 'cancelled', ...)
 * executa via reconcileStockForPaymentStatus ao cancelar um pedido pendente. NAO
 * chamamos adjustOrderPaymentStatus direto porque a sua server action exige
 * requireAdmin (contexto de request); o efeito de ESTOQUE (a invariante desta
 * feature) vive inteiramente em releaseStock + o CAS das flags do reconcile —
 * estes sim exercitados sem mock.
 *
 * DADOS PROPRIOS (anti-trivialidade): o ledger pede "produto com reserved>=qty" e
 * estorno de qty. Forcamos stock=20, reserved=R(5)>0 e qty=3 ANTES do cancelamento
 * (via UPDATE direto em `pg`) para que:
 *   - o estorno seja uma SUBTRACAO real em reserved (5->2), nao um 0->0 trivial;
 *   - reserved continue > 0 apos o estorno (2), provando que SO qty foi estornado;
 *   - stock fique CRAVADO em 20 (estorno NUNCA toca o estoque fisico), distinto de
 *     reserved, provando que o efeito atingiu apenas reserved.
 * reserved e gerido pelo ciclo de reserva (nunca por create/update do produto),
 * entao o UPDATE direto e a forma honesta de pre-posicionar reserved>0.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data/lib/db DIRETO no spec
 * quebra no load. Por isso a MUTACAO (CAS + releaseStock dentro de $transaction) roda
 * num processo `tsx` separado (tests/harness/estoque/_run-seam.ts, op
 * "releaseStockForOrder"), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: reserve-lifecycle-idempotent (flag stockReserved virada via
 * CAS na mesma tx do estorno), reserved-le-stock (CHECK valido; reserved nao fica
 * negativo).
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

const R = 5; // reserved inicial (>0; ainda > 0 apos o estorno, p/ tornar o assert nao-trivial)
const STOCK = 20; // estoque fisico (deve ficar INTOCADO pelo estorno)
const QTY = 3; // unidades do pedido (a estornar de reserved)
const PRICE_CENTS = 19990; // valor em centavos do produto (deve ficar INTOCADO)

test("estoque.release.reserved-on-cancel: cancelar pendente estorna reserva (reserved-=qty), stock intocado, idempotente via flag", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Release ${tag}`;
    const sku = `HARNESS-RELEASE-${tag}`;
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
        description: "fixture do harness para release-reserved-on-cancel",
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
    // Pre-condicao do ledger: reserved>=qty (o estorno cabe).
    expect(R, "reserved deve comportar o estorno (reserved >= qty)").toBeGreaterThanOrEqual(QTY);
    // Anti-trivialidade: reserved continua > 0 DEPOIS do estorno (R-QTY = 2 > 0).
    expect(R - QTY, "reserved deve sobrar > 0 apos o estorno").toBeGreaterThan(0);

    // --- setup C: cria um pedido PROPRIO PENDENTE com 1 item (productId, qty) e flags
    //     de reserva ativa (stockReserved=true, stockCommitted=false). O estorno le os
    //     PROPRIOS itens do pedido (como reconcileStockForPaymentStatus usa snap.items),
    //     entao o item real e quem define as `lines` do estorno.
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
        "Harness Release",
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

    // Sanidade do estado pre-cancelamento do pedido (reserva ativa, nao committed).
    const preOrder = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(preOrder.rowCount).toBe(1);
    expect(preOrder.rows[0].stock_reserved, "pre-cancel: stockReserved=true").toBe(true);
    expect(preOrder.rows[0].stock_committed, "pre-cancel: stockCommitted=false").toBe(false);

    // Conta audit_log inicial deste produto (o createProduct deixou 1) e o total, p/
    // provar que o estorno de ESTOQUE nao adultera o audit do produto (releaseStock e
    // efeito de inventario puro, sem audit proprio).
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);

    // --- acao: cancelar pendente => CAS da flag + releaseStock(tx, lines) na MESMA tx
    //     (ramo 'cancelled'->release do reconcile).
    const release = runSeam<SeamRelease>("releaseStockForOrder", { orderId });

    // --- assert (pre-condicao do efeito): o CAS reivindicou a transicao exatamente 1x.
    expect(release.released, "o CAS deve ter reivindicado a transicao (released===1)").toBe(1);

    // --- assert: products.reserved -= qty; products.stock INALTERADO (reserva nunca
    //     baixou estoque fisico).
    const after = await client.query<{ stock: number; reserved: number; price_cents: number }>(
      `SELECT stock, reserved, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount).toBe(1);
    const prod1 = after.rows[0];

    expect(prod1.reserved, "reserved deve cair qty (R - QTY)").toBe(R - QTY);
    expect(prod1.stock, "stock fisico NAO pode mudar no estorno").toBe(STOCK);
    expect(prod1.stock).toBe(prod0.stock);
    expect(Number.isInteger(prod1.stock)).toBe(true);
    expect(Number.isInteger(prod1.reserved)).toBe(true);
    // reserved baixou EXATAMENTE qty; stock teve delta ZERO (efeitos separados).
    expect(prod0.reserved - prod1.reserved, "delta de reserved == QTY").toBe(QTY);
    expect(prod0.stock - prod1.stock, "delta de stock == 0 (estorno nao toca estoque fisico)").toBe(
      0,
    );
    // Anti-trivial: reserved residual > 0 e distinto de stock.
    expect(prod1.reserved, "reserved residual > 0").toBeGreaterThan(0);
    expect(prod1.reserved).not.toBe(prod1.stock);

    // --- assert: Order.stockReserved == false; stockCommitted continua false.
    const afterOrder = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(afterOrder.rowCount).toBe(1);
    expect(afterOrder.rows[0].stock_reserved, "Order.stockReserved deve virar false").toBe(false);
    expect(afterOrder.rows[0].stock_committed, "Order.stockCommitted continua false").toBe(false);

    // --- assert: CHECK 0<=reserved<=stock valido (reserved nao fica negativo).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    // Reforco direto na linha alvo: reserved residual (2) >= 0 e <= stock (20).
    expect(prod1.reserved, "reserved residual nao pode ficar negativo").toBeGreaterThanOrEqual(0);
    expect(prod1.reserved <= prod1.stock, "reserved residual deve permanecer <= stock").toBe(true);

    // --- assert (cents-only nao afetado): valores em centavos do produto INTOCADOS.
    expect(prod1.price_cents, "price_cents do produto NAO pode mudar no estorno").toBe(PRICE_CENTS);
    expect(prod1.price_cents).toBe(prod0.price_cents);

    // --- assert (reserve-lifecycle-idempotent): aplicar o estorno de novo no MESMO pedido
    //     e no-op. O CAS WHERE stock_reserved=true AND stock_committed=false agora acha a
    //     flag ja virada -> 0 linhas -> releaseStock nao roda -> reserved nao decrementa
    //     em dobro (jamais negativo).
    const release2 = runSeam<SeamRelease>("releaseStockForOrder", { orderId });
    expect(release2.released, "2a aplicacao: CAS nao reivindica nada (released===0)").toBe(0);

    const after2 = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after2.rowCount).toBe(1);
    expect(after2.rows[0].reserved, "2a aplicacao e no-op: reserved permanece R-QTY").toBe(R - QTY);
    expect(after2.rows[0].stock, "2a aplicacao e no-op: stock permanece STOCK").toBe(STOCK);

    const order2 = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(order2.rows[0].stock_reserved, "flag continua false apos 2a aplicacao").toBe(false);
    expect(order2.rows[0].stock_committed, "stockCommitted continua false").toBe(false);

    // Rede final apos a repeticao: CHECK ainda intacto (sem decremento duplo -> negativo).
    const violations2 = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(
      Number(violations2.rows[0].count),
      "apos a 2a aplicacao nenhuma linha viola 0<=reserved<=stock",
    ).toBe(0);

    // --- rede final: o estorno de ESTOQUE nao gravou audit no produto (releaseStock e
    //     efeito de inventario; o audit do produto e so o product.create do setup).
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    expect(
      Number(afterAudit.rows[0].forEntity),
      "audit do produto inalterado pelo estorno de estoque",
    ).toBe(auditForEntityBefore);
    expect(Number(afterAudit.rows[0].total), "audit_log total inalterado pelo estorno").toBe(
      auditTotalBefore,
    );
  } finally {
    await client.end();
  }
});

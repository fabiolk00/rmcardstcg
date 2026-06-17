import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.shipping.regression-blocked (priority 10) — DB-first, sem browser.
 *
 * Prova "regressao de envio delivered -> sent e barrada" contra o Postgres efemero
 * REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (shipping-skip-blocked.spec.ts / shipping-sent-to-delivered.spec.ts): roda em Node
 * (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: updateOrderShippingStatus(orderId, 'sent', actor) de
 * lib/data/orders.ts (L523) — a funcao de menor nivel que prova as invariantes. Para a
 * transicao ILEGAL delivered->sent ela: abre prisma.$transaction, le o pedido (existing,
 * adminOrderSelect L502-509), trata X->X no-op (from!==to aqui), e ENTAO valida
 * `SHIPPING_TRANSITIONS[from].includes(to)` (L541). Como
 * SHIPPING_TRANSITIONS.delivered === [] (orderTransitions.ts L15: 'delivered' e TERMINAL,
 * sem destinos validos) NAO inclui "sent", a funcao retorna { ok:false,
 * reason:"invalid_transition", from:"delivered", to:"sent" } (L542) — ANTES do updateMany
 * (L545), de qualquer conciliacao de estoque (so to==='cancelled', L554) e de
 * writeAuditLog (L558). Logo NADA e gravado: shipping_status segue 'delivered' e nenhum
 * audit_log nasce. NAO chamamos a server action updateOrderShippingStatusAction porque
 * ela comeca com requireAdmin() (contexto de request: next/headers, Clerk), que quebra
 * fora do HTTP; a action so DELEGA para updateOrderShippingStatus.
 *
 * PRE-ESTADO TERMINAL: 'delivered' e terminal (nenhuma transicao legal sai dele), entao
 * nao da p/ alcanca-lo via seam a partir do pedido-alvo. Montamos o pre-estado com um
 * INSERT direto (shipping_status='delivered') — a forma honesta de exercitar a guarda do
 * estado terminal. shippingStatus e gerido pela maquina de envio; o INSERT direto so
 * monta a fixture inicial, e a unica escrita medida e a SEAM de PRODUCAO.
 *
 * DADOS PROPRIOS (anti-trivialidade): criamos um PRODUTO proprio (createProduct,
 * SKU/nome unicos por run) e um PEDIDO proprio (INSERT direto em `pg`) com
 * shippingStatus=delivered + 1 item (QTY>0). FORCAMOS o produto com reserved=RESERVED0
 * (>0) e stock=STOCK0 e o pedido com stockReserved=true (reserva ativa). Assim, mesmo que
 * a transicao barrada tocasse o estoque por engano (ou pulasse a validacao e aplicasse),
 * stock/reserved/flags mudariam — o teste so passa porque a producao REJEITA a transicao
 * antes de qualquer escrita: estado de pedido E de estoque ficam INTACTOS. reserved e
 * gerido pelo ciclo de reserva (reserveStock no checkout), nunca por uma escrita de admin
 * avulsa, entao o UPDATE direto e a forma honesta de montar o pre-estado (RESERVED0 <=
 * STOCK0 respeita o CHECK).
 *
 * CONTRA-PROVA (a barreira nao e tautologica): como 'delivered' nao tem NENHUM destino
 * legal, a contra-prova vem de um SEGUNDO pedido em estado 'sent', onde a transicao
 * sent->delivered (em SHIPPING_TRANSITIONS.sent) APLICA (ok:true, changed:true) e deixa
 * exatamente 1 audit. Isso prova que o ok:false de delivered->sent vem da maquina de
 * estados (regressao de estado terminal), nao de um erro generico que barraria qualquer
 * transicao. Reforco direcional: o MESMO pedido-alvo (delivered) tambem barra
 * delivered->cancelled (outro destino) — confirmando que 'delivered' e terminal de fato.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso as MUTACOES (createProduct/updateOrderShippingStatus) rodam num processo `tsx`
 * separado (tests/harness/estoque/_run-seam.ts, ja suporta updateOrderShippingStatus),
 * herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: order-state-machine (regressao delivered->sent barrada por
 * SHIPPING_TRANSITIONS.delivered===[]; contra-prova com sent->delivered legal em outro
 * pedido), audit-same-tx (a transicao ilegal retorna ANTES de writeAuditLog => nenhum
 * audit orfao).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type AdminOrderUpdate =
  | { ok: false; reason: string; from?: string; to?: string }
  | { ok: true; changed: boolean; order: { shippingStatus: string } };

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
const STOCK0 = 10; // estoque do produto (deve ficar intocado: transicao barrada)
const RESERVED0 = QTY; // reserva pre-existente (>0 p/ tornar "nada gravado" nao-trivial)
const UNIT_PRICE = 4999; // centavos (Int) por unidade

/** Insere um PEDIDO PROPRIO com o shipping_status pedido + 1 item (QTY) do produto. */
async function insertOrder(
  client: Client,
  productId: string,
  tag: string,
  shippingStatus: string,
): Promise<number> {
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
       'paid', 'pix', $11,
       true, false
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
      shippingStatus,
    ],
  );
  const orderId = ins.rows[0].id;
  await client.query(
    `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), orderId, productId, `Produto Harness Regr ${tag}`, QTY, UNIT_PRICE],
  );
  return orderId;
}

async function shipAuditCount(client: Client, orderId: number): Promise<number> {
  const r = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "audit_log"
       WHERE entity_id = $1 AND entity_type = 'order'
         AND action = 'order.shipping_status_update'`,
    [String(orderId)],
  );
  return Number(r.rows[0].count);
}

test("pedido.shipping.regression-blocked: delivered->sent barrado (invalid_transition), nada gravado", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };

    // --- setup A: produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness Regr ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-REGR-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999, // valor inicial irrelevante; forcado abaixo
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para shipping-regression-blocked",
      },
    });
    const productId = created.id;

    // --- setup B: FORCA reserved=RESERVED0(>0) e stock=STOCK0 p/ refletir uma reserva
    //     ativa. Se a regressao escapasse a validacao (ou conciliasse estoque), isso
    //     mudaria; aqui prova que NAO muda. reserved e gerido pelo ciclo de reserva (nunca
    //     por admin avulso), entao o UPDATE direto e a forma honesta de montar o pre-estado
    //     (RESERVED0<=STOCK0).
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK0,
      RESERVED0,
      productId,
    ]);

    // --- setup C: PEDIDO-ALVO PROPRIO com shippingStatus=delivered (TERMINAL) + 1 item
    //     (QTY). stockReserved=true reflete a reserva ativa (anti-trivialidade do "nada
    //     gravado"). 'delivered' e terminal, entao montamos via INSERT direto (a unica
    //     escrita MEDIDA e a seam de PRODUCAO depois).
    const orderId = await insertOrder(client, productId, tag, "delivered");

    // Sanidade do pre-estado.
    const pre = await client.query<{
      shipping_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT shipping_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(pre.rows[0].shipping_status, "pre: shipping_status=delivered (terminal)").toBe(
      "delivered",
    );
    expect(pre.rows[0].stock_reserved, "pre: stockReserved=true (reserva ativa)").toBe(true);
    expect(pre.rows[0].stock_committed, "pre: stockCommitted=false").toBe(false);

    const preP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(preP.rows[0].stock, "pre: stock=STOCK0").toBe(STOCK0);
    expect(preP.rows[0].reserved, "pre: reserved=RESERVED0 (>0, nao trivial)").toBe(RESERVED0);
    expect(RESERVED0).toBeGreaterThan(0);

    // Contagem de audit antes (total e por entity_id do PEDIDO). entity_id de pedido e
    // String(orderId) (schema usa string p/ acomodar uuid de produto e int de pedido).
    const entityId = String(orderId);
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    // Pedido recem-inserido nao tem audit ainda.
    expect(auditForEntityBefore, "pedido novo nao tem audit ainda").toBe(0);

    // --- acao: updateOrderShippingStatus(orderId, 'sent', actor) REGREDINDO de 'delivered'
    //     (seam de PRODUCAO).
    const res = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId,
      to: "sent",
      actor,
    });

    // --- assert 1: Resultado ok:false reason='invalid_transition' from=delivered to=sent.
    expect(res.ok, "regressao delivered->sent deve ser barrada (ok:false)").toBe(false);
    if (!res.ok) {
      expect(res.reason, "reason deve ser 'invalid_transition'").toBe("invalid_transition");
      expect(res.from, "from deve ser 'delivered'").toBe("delivered");
      expect(res.to, "to deve ser 'sent'").toBe("sent");
    }

    // --- assert 2: orders.shipping_status permanece 'delivered' (nada gravado).
    const ord = await client.query<{
      shipping_status: string;
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(
      `SELECT shipping_status, payment_status, stock_reserved, stock_committed
         FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(ord.rowCount).toBe(1);
    expect(ord.rows[0].shipping_status, "shipping_status permanece 'delivered'").toBe("delivered");
    // payment_status nao e tocado pela maquina de envio.
    expect(ord.rows[0].payment_status, "payment_status inalterado (paid)").toBe("paid");
    // Flags do pedido intactas (transicao barrada nao concilia estoque).
    expect(ord.rows[0].stock_reserved, "stockReserved INALTERADO (true)").toBe(true);
    expect(ord.rows[0].stock_committed, "stockCommitted INALTERADO (false)").toBe(false);

    // Estoque do produto intacto (nenhuma escrita ocorreu).
    const postP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(postP.rowCount).toBe(1);
    expect(postP.rows[0].stock, "stock INALTERADO (transicao barrada)").toBe(STOCK0);
    expect(postP.rows[0].reserved, "reserved INALTERADO (transicao barrada)").toBe(RESERVED0);

    // Rede final (reserved-le-stock): CHECK existe + 0 violacoes de 0<=reserved<=stock.
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);

    // --- assert 3: audit_log NAO ganha linha (audit-same-tx: a transicao ilegal retorna
    //     ANTES de writeAuditLog, entao nada e gravado — total E por-entity).
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    expect(
      Number(afterAudit.rows[0].total),
      "audit_log total inalterado (transicao barrada nao audita)",
    ).toBe(auditTotalBefore);
    expect(
      Number(afterAudit.rows[0].forEntity),
      "este pedido NAO ganha audit pela transicao barrada",
    ).toBe(auditForEntityBefore);
    // Reforco: zero linhas de order.shipping_status_update p/ este pedido (sem orfao).
    expect(
      await shipAuditCount(client, orderId),
      "nenhum order.shipping_status_update orfao da regressao barrada",
    ).toBe(0);

    // --- REFORCO DIRECIONAL: 'delivered' e terminal de FATO — delivered->cancelled (outro
    //     destino) tambem e barrado, e o pedido-alvo segue 'delivered' sem audit.
    const alsoBlocked = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId,
      to: "cancelled",
      actor,
    });
    expect(alsoBlocked.ok, "delivered->cancelled tambem barrado (terminal)").toBe(false);
    if (!alsoBlocked.ok) {
      expect(alsoBlocked.reason, "reason 'invalid_transition' tambem aqui").toBe(
        "invalid_transition",
      );
      expect(alsoBlocked.from, "from 'delivered'").toBe("delivered");
      expect(alsoBlocked.to, "to 'cancelled'").toBe("cancelled");
    }
    const ordStill = await client.query<{ shipping_status: string }>(
      `SELECT shipping_status FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(ordStill.rows[0].shipping_status, "pedido-alvo segue 'delivered'").toBe("delivered");
    expect(
      await shipAuditCount(client, orderId),
      "ainda zero audit no pedido-alvo (terminal nao transita p/ lugar nenhum)",
    ).toBe(0);

    // --- CONTRA-PROVA (a barreira nao e tautologica): 'delivered' nao tem destino legal
    //     algum, entao usamos um SEGUNDO pedido em 'sent', de onde sent->delivered APLICA
    //     (ok:true, changed:true) e deixa exatamente 1 audit. Prova que o ok:false acima vem
    //     da maquina de estados (regressao de terminal), nao de um erro que barraria tudo.
    const sentOrderId = await insertOrder(client, productId, `${tag}-cp`, "sent");
    const legal = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId: sentOrderId,
      to: "delivered",
      actor,
    });
    expect(legal.ok, "contra-prova: sent->delivered deve ser legal (ok:true)").toBe(true);
    if (legal.ok) {
      expect(legal.changed, "contra-prova: sent->delivered aplica (changed=true)").toBe(true);
      expect(legal.order.shippingStatus, "contra-prova: order retornado em delivered").toBe(
        "delivered",
      );
    }
    const ordLegal = await client.query<{ shipping_status: string }>(
      `SELECT shipping_status FROM "orders" WHERE id = $1`,
      [sentOrderId],
    );
    expect(
      ordLegal.rows[0].shipping_status,
      "contra-prova: 2o pedido agora 'delivered' (transicao legal aplicou)",
    ).toBe("delivered");
    // E a transicao legal SIM deixa exatamente 1 audit (delta entre barrado e legal).
    expect(
      await shipAuditCount(client, sentOrderId),
      "contra-prova: sent->delivered legal deixa 1 audit (o regressao barrada nao deixou nenhum)",
    ).toBe(1);
    // E o pedido-ALVO (delivered) segue intacto: a transicao legal foi de OUTRO pedido.
    expect(
      await shipAuditCount(client, orderId),
      "pedido-alvo permanece sem audit apos a contra-prova noutro pedido",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

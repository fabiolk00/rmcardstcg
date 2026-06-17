import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.shipping.sent-to-delivered (priority 8) — DB-first, sem browser.
 *
 * Prova "admin marca envio sent -> delivered (terminal, auditado)" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO da spec irma
 * (shipping-pending-to-sent.spec.ts): roda em Node (sem `page`) e assertaa o estado
 * real via `pg`.
 *
 * SEAM escolhida: updateOrderShippingStatus(orderId, 'delivered', actor) de
 * lib/data/orders.ts (L523) — a funcao de menor nivel que prova as invariantes:
 * abre prisma.$transaction, le o pedido (before, adminOrderSelect), trata X->X
 * no-op, valida a transicao contra SHIPPING_TRANSITIONS (sent inclui 'delivered' =>
 * legal), aplica via compare-and-swap atomico (updateMany WHERE shippingStatus=from),
 * NAO concilia estoque (so to==='cancelled' dispara reconcileStockForPaymentStatus)
 * e grava audit_log (action order.shipping_status_update, before/after snapshots) —
 * TUDO na MESMA tx. NAO chamamos a server action updateOrderShippingStatusAction
 * porque ela comeca com requireAdmin() (contexto de request: next/headers, Clerk),
 * que quebra fora do HTTP; a action so DELEGA para updateOrderShippingStatus.
 *
 * ASSERT 3 — "delivered e terminal": SHIPPING_TRANSITIONS.delivered === [] (vazio,
 * orderTransitions.ts L15). Provamos isso de forma honesta e empirica: APOS alcancar
 * 'delivered', tentamos SAIR de delivered para CADA outro estado (sent, pending,
 * cancelled). A producao deve devolver { ok:false, reason:'invalid_transition',
 * from:'delivered', to:* } SEM gravar nada (shipping_status permanece 'delivered',
 * audit_log NAO ganha linha). Isso prova que delivered nao tem destino valido (e a
 * unica auto-transicao delivered->delivered seria um no-op idempotente, nao um destino).
 *
 * DADOS PROPRIOS (anti-trivialidade): criamos um PRODUTO proprio (createProduct,
 * SKU/nome unicos por run) e um PEDIDO proprio (INSERT direto em `pg`) com
 * shippingStatus=sent + 1 item (QTY>0). ANTI-TRIVIALIDADE p/ "nenhum efeito de
 * estoque": FORCAMOS o produto com reserved=RESERVED0(>0) e stock=STOCK0 e o pedido
 * com stockReserved=true (reserva ativa). Se a transicao 'delivered' tocasse o estoque
 * por engano, stock/reserved/flags mudariam — o teste so passa porque a transicao de
 * envio (nao-cancelamento) NAO concilia: stock/reserved/flags ficam INTACTOS. reserved
 * e gerido pelo ciclo de reserva (reserveStock no checkout), nunca por uma escrita de
 * admin avulsa, entao o UPDATE direto e a forma honesta de montar o pre-estado
 * (RESERVED0 <= STOCK0 respeita o CHECK).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as MUTACOES (createProduct/updateOrderShippingStatus) rodam num
 * processo `tsx` separado (tests/harness/estoque/_run-seam.ts, ja suporta
 * updateOrderShippingStatus), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: order-state-machine (sent->delivered legal via
 * SHIPPING_TRANSITIONS, CAS; delivered terminal => todos os destinos barrados),
 * audit-same-tx (1 linha order.shipping_status_update na MESMA tx, before/after
 * corretos; transicao barrada NAO deixa audit orfao).
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
const STOCK0 = 10; // estoque do produto (intocado: envio nao concilia)
const RESERVED0 = QTY; // reserva pre-existente (>0 p/ tornar "nenhum efeito de estoque" nao-trivial)
const UNIT_PRICE = 4999; // centavos (Int) por unidade

test("pedido.shipping.sent-to-delivered: transicao legal auditada na mesma tx; delivered terminal", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };

    // --- setup A: produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness Deliv ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-DELIV-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999, // valor inicial irrelevante; forcado abaixo
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para shipping-sent-to-delivered",
      },
    });
    const productId = created.id;

    // --- setup B: FORCA reserved=RESERVED0(>0) e stock=STOCK0 p/ refletir uma reserva
    //     ativa. Se 'delivered' tocasse estoque por engano, isso mudaria; aqui prova que
    //     NAO muda. reserved e gerido pelo ciclo de reserva (nunca por admin avulso),
    //     entao o UPDATE direto e a forma honesta de montar o pre-estado (RESERVED0<=STOCK0).
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK0,
      RESERVED0,
      productId,
    ]);

    // --- setup C: PEDIDO PROPRIO com shippingStatus=sent + 1 item (QTY) deste produto.
    //     stockReserved=true reflete a reserva ativa (anti-trivialidade do "sem efeito").
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
         'paid', 'pix', 'sent',
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
      ],
    );
    const orderId = ins.rows[0].id;

    await client.query(
      `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), orderId, productId, `Produto Harness Deliv ${tag}`, QTY, UNIT_PRICE],
    );

    // Sanidade do pre-estado.
    const pre = await client.query<{
      shipping_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT shipping_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(pre.rows[0].shipping_status, "pre: shipping_status=sent").toBe("sent");
    expect(pre.rows[0].stock_reserved, "pre: stockReserved=true (reserva ativa)").toBe(true);
    expect(pre.rows[0].stock_committed, "pre: stockCommitted=false").toBe(false);

    const preP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(preP.rows[0].stock, "pre: stock=STOCK0").toBe(STOCK0);
    expect(preP.rows[0].reserved, "pre: reserved=RESERVED0 (>0, nao trivial)").toBe(RESERVED0);
    expect(RESERVED0).toBeGreaterThan(0);

    // Contagem de audit antes (total e por entity_id do PEDIDO). entity_id de pedido
    // e String(orderId) (schema usa string p/ acomodar uuid de produto e int de pedido).
    const entityId = String(orderId);
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    // Pedido recem-inserido nao tem audit ainda; o update de envio deve somar +1.
    expect(auditForEntityBefore, "pedido novo nao tem audit ainda").toBe(0);

    // --- acao: updateOrderShippingStatus(orderId, 'delivered', actor) (seam de PRODUCAO).
    const res = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId,
      to: "delivered",
      actor,
    });
    expect(res.ok, "transicao sent->delivered deve ser ok").toBe(true);
    if (res.ok) {
      expect(res.changed, "transicao legal deve aplicar (changed=true)").toBe(true);
      expect(res.order.shippingStatus, "order retornado em delivered").toBe("delivered");
    }

    // --- assert 1: orders.shipping_status == 'delivered' (sent->delivered legal).
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
    expect(ord.rows[0].shipping_status, "shipping_status deve virar 'delivered'").toBe("delivered");
    // payment_status nao e tocado pela maquina de envio.
    expect(ord.rows[0].payment_status, "payment_status inalterado (paid)").toBe("paid");

    // Nenhum efeito de estoque (so cancelamento concilia). stock/reserved do produto e
    // as flags do pedido ficam INTACTOS apesar da reserva ativa.
    const postP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(postP.rowCount).toBe(1);
    expect(postP.rows[0].stock, "stock INALTERADO (envio nao concilia)").toBe(STOCK0);
    expect(postP.rows[0].reserved, "reserved INALTERADO (envio nao concilia)").toBe(RESERVED0);
    expect(ord.rows[0].stock_reserved, "stockReserved INALTERADO (true)").toBe(true);
    expect(ord.rows[0].stock_committed, "stockCommitted INALTERADO (false)").toBe(false);

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

    // --- assert 2: audit_log recebe EXATAMENTE 1 linha nova p/ o pedido, action=
    //     order.shipping_status_update, na MESMA tx, before.shippingStatus=sent,
    //     after.shippingStatus=delivered.
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    expect(Number(afterAudit.rows[0].total), "audit_log total deve ganhar 1 linha").toBe(
      auditTotalBefore + 1,
    );
    expect(Number(afterAudit.rows[0].forEntity), "este pedido deve ganhar 1 linha de audit").toBe(
      auditForEntityBefore + 1,
    );

    const log = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: { shippingStatus: string; paymentStatus: string } | null;
      after: { shippingStatus: string; paymentStatus: string } | null;
    }>(
      `SELECT action, entity_type, entity_id, before, after
         FROM "audit_log"
         WHERE entity_id = $1 AND entity_type = 'order'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      [entityId],
    );
    expect(log.rowCount).toBe(1);
    const a = log.rows[0];

    // action gravado com o valor DOTTED do @map (schema.prisma L54:
    // order_shipping_status_update @map("order.shipping_status_update")). Lemos a coluna
    // crua via pg, nao a chave JS do enum (que e 'order_shipping_status_update').
    expect(a.action, "action deve ser o valor @map dotted").toBe("order.shipping_status_update");
    expect(a.entity_type).toBe("order");
    expect(a.entity_id).toBe(entityId);

    // before/after sao snapshots do dominio (camelCase). before.shippingStatus=sent,
    // after.shippingStatus=delivered; paymentStatus identico nos dois (delta limpo: so envio mudou).
    expect(a.before, "before deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.after, "after deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.before!.shippingStatus, "before.shippingStatus deve refletir 'sent'").toBe("sent");
    expect(a.after!.shippingStatus, "after.shippingStatus deve refletir 'delivered'").toBe(
      "delivered",
    );
    expect(
      a.after!.paymentStatus,
      "paymentStatus identico nos dois snapshots (so envio mudou)",
    ).toBe(a.before!.paymentStatus);

    // --- assert 3: 'delivered' e TERMINAL — sem destinos validos depois. Provamos
    //     empiricamente: APOS delivered, tentamos sair para CADA outro estado e a
    //     producao deve barrar (ok:false, invalid_transition), sem mudar shipping_status
    //     nem somar audit. SHIPPING_TRANSITIONS.delivered === [] (orderTransitions.ts L15).
    const auditAfterDelivered = afterAudit; // baseline p/ provar "nenhum audit novo"
    const auditTotalDelivered = Number(auditAfterDelivered.rows[0].total);
    const auditForEntityDelivered = Number(auditAfterDelivered.rows[0].forEntity);

    for (const target of ["sent", "pending", "cancelled"] as const) {
      const blocked = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
        orderId,
        to: target,
        actor,
      });
      expect(blocked.ok, `delivered->${target} deve ser barrado (ok:false)`).toBe(false);
      if (!blocked.ok) {
        expect(blocked.reason, `delivered->${target}: reason invalid_transition`).toBe(
          "invalid_transition",
        );
        expect(blocked.from, `delivered->${target}: from=delivered`).toBe("delivered");
        expect(blocked.to, `delivered->${target}: to=${target}`).toBe(target);
      }
    }

    // Estado inalterado apos as tentativas barradas: shipping_status segue 'delivered'.
    const ordTerm = await client.query<{ shipping_status: string }>(
      `SELECT shipping_status FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(
      ordTerm.rows[0].shipping_status,
      "shipping_status permanece 'delivered' apos transicoes barradas",
    ).toBe("delivered");

    // Nenhum audit orfao das tentativas barradas (audit-same-tx: transicao ilegal
    // retorna ANTES de writeAuditLog, entao nada e gravado).
    const auditTerm = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    expect(
      Number(auditTerm.rows[0].total),
      "audit_log total inalterado apos transicoes barradas",
    ).toBe(auditTotalDelivered);
    expect(
      Number(auditTerm.rows[0].forEntity),
      "audit do pedido inalterado apos transicoes barradas",
    ).toBe(auditForEntityDelivered);
  } finally {
    await client.end();
  }
});

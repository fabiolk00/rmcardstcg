import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.shipping.skip-blocked (priority 9) — DB-first, sem browser.
 *
 * Prova "pulo de etapa de envio pending -> delivered e barrado" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (shipping-pending-to-sent.spec.ts / shipping-sent-to-delivered.spec.ts): roda em
 * Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: updateOrderShippingStatus(orderId, 'delivered', actor) de
 * lib/data/orders.ts (L523) — a funcao de menor nivel que prova as invariantes. Para
 * a transicao ILEGAL pending->delivered ela: abre prisma.$transaction, le o pedido
 * (existing, adminOrderSelect L502-509), trata X->X no-op (from!==to aqui), e ENTAO
 * valida `SHIPPING_TRANSITIONS[from].includes(to)` (L541). Como
 * SHIPPING_TRANSITIONS.pending === ["sent","cancelled"] (orderTransitions.ts L13) NAO
 * inclui "delivered", a funcao retorna { ok:false, reason:"invalid_transition",
 * from:"pending", to:"delivered" } (L542) — ANTES do updateMany (L545), de qualquer
 * conciliacao de estoque (so to==='cancelled', L554) e de writeAuditLog (L558). Logo
 * NADA e gravado: shipping_status segue 'pending' e nenhum audit_log nasce. NAO
 * chamamos a server action updateOrderShippingStatusAction porque ela comeca com
 * requireAdmin() (contexto de request: next/headers, Clerk), que quebra fora do HTTP;
 * a action so DELEGA para updateOrderShippingStatus.
 *
 * DADOS PROPRIOS (anti-trivialidade): criamos um PRODUTO proprio (createProduct,
 * SKU/nome unicos por run) e um PEDIDO proprio (INSERT direto em `pg`) com
 * shippingStatus=pending + 1 item (QTY>0). FORCAMOS o produto com reserved=RESERVED0
 * (>0) e stock=STOCK0 e o pedido com stockReserved=true (reserva ativa). Assim,
 * mesmo que a transicao barrada tocasse o estoque por engano (ou pulasse a validacao
 * e aplicasse), stock/reserved/flags mudariam — o teste so passa porque a producao
 * REJEITA a transicao antes de qualquer escrita: estado de pedido E de estoque
 * ficam INTACTOS. reserved e gerido pelo ciclo de reserva (reserveStock no checkout),
 * nunca por uma escrita de admin avulsa, entao o UPDATE direto e a forma honesta de
 * montar o pre-estado (RESERVED0 <= STOCK0 respeita o CHECK).
 *
 * CONTRA-PROVA (a barreira nao e tautologica): a partir do MESMO estado 'pending', a
 * transicao LEGAL pending->sent (em SHIPPING_TRANSITIONS.pending) APLICA (ok:true,
 * changed:true). Isso prova que o ok:false de pending->delivered vem da maquina de
 * estados (pulo de etapa), nao de um erro generico que barraria qualquer transicao.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as MUTACOES (createProduct/updateOrderShippingStatus) rodam num
 * processo `tsx` separado (tests/harness/estoque/_run-seam.ts, ja suporta
 * updateOrderShippingStatus), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: order-state-machine (pulo pending->delivered barrado por
 * SHIPPING_TRANSITIONS; contra-prova com pending->sent legal), audit-same-tx (a
 * transicao ilegal retorna ANTES de writeAuditLog => nenhum audit orfao).
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

test("pedido.shipping.skip-blocked: pending->delivered barrado (invalid_transition), nada gravado", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };

    // --- setup A: produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness Skip ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-SKIP-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999, // valor inicial irrelevante; forcado abaixo
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para shipping-skip-blocked",
      },
    });
    const productId = created.id;

    // --- setup B: FORCA reserved=RESERVED0(>0) e stock=STOCK0 p/ refletir uma reserva
    //     ativa. Se a transicao barrada escapasse a validacao (ou conciliasse estoque),
    //     isso mudaria; aqui prova que NAO muda. reserved e gerido pelo ciclo de reserva
    //     (nunca por admin avulso), entao o UPDATE direto e a forma honesta de montar o
    //     pre-estado (RESERVED0<=STOCK0).
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK0,
      RESERVED0,
      productId,
    ]);

    // --- setup C: PEDIDO PROPRIO com shippingStatus=pending + 1 item (QTY) deste produto.
    //     stockReserved=true reflete a reserva ativa (anti-trivialidade do "nada gravado").
    //     paymentStatus='paid': a CONTRA-PROVA no fim deste teste (pending->sent legal)
    //     agora EXIGE pagamento confirmado (shipping-sent-requires-payment.spec.ts).
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
         'paid', 'pix', 'pending',
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
      [randomUUID(), orderId, productId, `Produto Harness Skip ${tag}`, QTY, UNIT_PRICE],
    );

    // Sanidade do pre-estado.
    const pre = await client.query<{
      shipping_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT shipping_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(pre.rows[0].shipping_status, "pre: shipping_status=pending").toBe("pending");
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
    // Pedido recem-inserido nao tem audit ainda.
    expect(auditForEntityBefore, "pedido novo nao tem audit ainda").toBe(0);

    // --- acao: updateOrderShippingStatus(orderId, 'delivered', actor) PULANDO 'sent'
    //     (seam de PRODUCAO).
    const res = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId,
      to: "delivered",
      actor,
    });

    // --- assert 1: Resultado ok:false reason='invalid_transition' from=pending to=delivered.
    expect(res.ok, "pulo pending->delivered deve ser barrado (ok:false)").toBe(false);
    if (!res.ok) {
      expect(res.reason, "reason deve ser 'invalid_transition'").toBe("invalid_transition");
      expect(res.from, "from deve ser 'pending'").toBe("pending");
      expect(res.to, "to deve ser 'delivered'").toBe("delivered");
    }

    // --- assert 2: orders.shipping_status permanece 'pending' (nada gravado).
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
    expect(ord.rows[0].shipping_status, "shipping_status permanece 'pending'").toBe("pending");
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

    // --- assert 3: audit_log NAO ganha linha (audit-same-tx: a transicao ilegal
    //     retorna ANTES de writeAuditLog, entao nada e gravado — total E por-entity).
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
    const shipAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE entity_id = $1 AND entity_type = 'order'
           AND action = 'order.shipping_status_update'`,
      [entityId],
    );
    expect(
      Number(shipAudit.rows[0].count),
      "nenhum order.shipping_status_update orfao do pulo barrado",
    ).toBe(0);

    // --- CONTRA-PROVA (a barreira nao e tautologica): do MESMO estado 'pending', a
    //     transicao LEGAL pending->sent APLICA. Isso prova que o ok:false acima vem da
    //     maquina de estados (pulo de etapa), nao de um erro que barraria tudo.
    const legal = runSeam<AdminOrderUpdate>("updateOrderShippingStatus", {
      orderId,
      to: "sent",
      actor,
    });
    expect(legal.ok, "contra-prova: pending->sent deve ser legal (ok:true)").toBe(true);
    if (legal.ok) {
      expect(legal.changed, "contra-prova: pending->sent aplica (changed=true)").toBe(true);
      expect(legal.order.shippingStatus, "contra-prova: order retornado em sent").toBe("sent");
    }
    const ordLegal = await client.query<{ shipping_status: string }>(
      `SELECT shipping_status FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(
      ordLegal.rows[0].shipping_status,
      "contra-prova: shipping_status agora 'sent' (transicao legal aplicou)",
    ).toBe("sent");
    // E a transicao legal SIM deixa exatamente 1 audit (delta entre barrado e legal).
    const auditLegal = await client.query<{ forEntity: string }>(
      `SELECT COUNT(*)::text AS "forEntity" FROM "audit_log"
         WHERE entity_id = $1 AND entity_type = 'order'
           AND action = 'order.shipping_status_update'`,
      [entityId],
    );
    expect(
      Number(auditLegal.rows[0].forEntity),
      "contra-prova: transicao legal pending->sent deixa 1 audit (o barrado nao deixou nenhum)",
    ).toBe(1);
  } finally {
    await client.end();
  }
});

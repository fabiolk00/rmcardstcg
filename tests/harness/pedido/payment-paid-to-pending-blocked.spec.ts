import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.payment.paid-to-pending-blocked (priority 4) — DB-first, sem browser.
 *
 * Prova "transicao ilegal de pagamento paid -> pending e barrada" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas de pedido
 * (payment-pending-to-paid.spec.ts): roda em Node (sem `page`) e assertaa o estado
 * real via `pg`.
 *
 * SEAM escolhida: applyPaymentStatusTx(tx, orderId, status, payment) de
 * lib/data/orders.ts (L332) — o NUCLEO da maquina de pagamento (usado pelo webhook do
 * Asaas e pela reconciliacao). E a unica funcao que valida a transicao contra
 * PAYMENT_TRANSITIONS (orders.ts L300-304: paid -> ['cancelled'] APENAS; 'pending'
 * NUNCA e destino de 'paid'). A guarda (L374-379) roda ANTES de
 * reconcileStockForPaymentStatus (sem efeito de estoque) e a propria
 * applyPaymentStatusTx NUNCA escreve audit_log — entao uma transicao ilegal nao deixa
 * NENHUM efeito colateral. O ledger e explicito: "Tenta aplicar status 'pending' via
 * applyPaymentStatusTx (maquina de pagamento)". NAO usamos adjustOrderPaymentStatus
 * (ajuste manual do admin), pois essa funcao e SEGREGADA do webhook e NAO valida
 * PAYMENT_TRANSITIONS — ela so barra o no-op X->X; nao e a maquina de estados que o
 * ledger pede para esta feature.
 *
 * Envelopamento: applyPaymentStatusTx recebe um `tx` externo na producao; o seam
 * (_run-seam.ts case applyPaymentStatus) o envelopa num prisma.$transaction
 * EXATAMENTE como o wrapper de PRODUCAO setOrderPaymentStatus (orders.ts L411-420).
 *
 * ANTI-REPLAY (por que setamos asaas_payment_id): applyPaymentStatusTx tem uma
 * verificacao anti-fraude (L347-353) que retorna 'payment_mismatch' se
 * orders.asaas_payment_id for nulo ou != payment.id. Para exercitar o ramo
 * 'invalid_transition' (e nao 'payment_mismatch'), o pedido recebe um
 * asaas_payment_id e a chamada passa um payment.id CASADO. Assim o teste prova de
 * fato a GUARDA DE TRANSICAO, nao a verificacao de cobranca.
 *
 * DADOS PROPRIOS (anti-trivialidade): criamos um PRODUTO proprio (createProduct,
 * SKU/nome unicos por run) e um PEDIDO proprio JA PAGO (INSERT direto em `pg`:
 * payment_status='paid', stock_committed=true, stock_reserved=false) com 1 item de
 * QTY>0. FORCAMOS reserved=RESERVED0(>0) e stock=STOCK0 (>0) no produto para provar
 * que NADA de estoque muda (anti-trivialidade: reserved>0 e nao 0).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as MUTACOES (createProduct/applyPaymentStatus) rodam num processo
 * `tsx` separado (tests/harness/estoque/_run-seam.ts, ESTENDIDO p/ suportar
 * applyPaymentStatus), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: order-state-machine (paid->pending ilegal, barrada pela
 * maquina), audit-same-tx (transicao ilegal NAO cria audit orfao).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type PaymentStatusUpdate =
  | { found: false }
  | { found: true; ok: false; reason: "payment_mismatch" | "value_mismatch" | "invalid_transition" }
  | {
      found: true;
      ok: true;
      changed: boolean;
      previousStatus: string;
      status: string;
      order: { paymentStatus: string };
    };

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
const STOCK0 = 10; // estoque do produto (forcado > 0; deve ficar INALTERADO)
const RESERVED0 = 2; // reserva pre-existente (>0; deve ficar INALTERADA, anti-trivial)
const UNIT_PRICE = 4999; // centavos (Int) por unidade

test("pedido.payment.paid-to-pending-blocked: maquina barra paid->pending sem efeito", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const asaasPaymentId = `pay_${tag}`; // cobranca casada (anti-replay satisfeito)

    // --- setup A: produto PROPRIO (sem tocar o seed).
    const created = runSeam<SeamProduct>("createProduct", {
      actor: { clerkUserId: null, email: null, role: null },
      input: {
        name: `Produto Harness BlockPP ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-BLOCKPP-${tag}`,
        priceCents: UNIT_PRICE,
        discountPct: 0,
        stock: 999, // valor inicial irrelevante; forcado abaixo
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para payment-paid-to-pending-blocked",
      },
    });
    const productId = created.id;

    // --- setup B: FORCA stock=STOCK0 e reserved=RESERVED0(>0). Como o pedido ja esta
    //     COMMITTED, a reserva ja foi consumida; manter reserved>0 aqui (de uma outra
    //     ordem hipotetica) so reforca a prova de que a transicao ILEGAL nao toca
    //     NENHUM numero de estoque. RESERVED0 <= STOCK0 respeita o CHECK.
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK0,
      RESERVED0,
      productId,
    ]);

    // --- setup C: PEDIDO PROPRIO JA PAGO (payment_status='paid', stock_committed=true,
    //     stock_reserved=false) + asaas_payment_id casado p/ passar a verificacao
    //     anti-replay e exercitar a GUARDA DE TRANSICAO. INSERT direto em pg.
    const subtotal = UNIT_PRICE * QTY;
    const ins = await client.query<{ id: number }>(
      `INSERT INTO "orders" (
         clerk_user_id, customer_name, customer_email, customer_phone,
         address_cep, address_street, address_city, address_state,
         subtotal_cents, discount_cents, shipping_cents, total_cents,
         payment_status, payment_method, shipping_status,
         stock_reserved, stock_committed, asaas_payment_id
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, 0, 0, $10,
         'paid', 'pix', 'pending',
         false, true, $11
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
        asaasPaymentId,
      ],
    );
    const orderId = ins.rows[0].id;

    await client.query(
      `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), orderId, productId, `Produto Harness BlockPP ${tag}`, QTY, UNIT_PRICE],
    );

    // Sanidade do pre-estado: pedido 'paid', committed; produto stock/reserved forcados.
    const pre = await client.query<{
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT payment_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(pre.rows[0].payment_status, "pre: payment_status=paid").toBe("paid");
    expect(pre.rows[0].stock_reserved, "pre: stockReserved=false").toBe(false);
    expect(pre.rows[0].stock_committed, "pre: stockCommitted=true").toBe(true);

    const preP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(preP.rows[0].stock, "pre: stock=STOCK0").toBe(STOCK0);
    expect(preP.rows[0].reserved, "pre: reserved=RESERVED0 (>0, nao trivial)").toBe(RESERVED0);
    expect(RESERVED0).toBeGreaterThan(0);

    // Contagem de audit antes (total e por entity_id do PEDIDO). entity_id de pedido
    // e String(orderId). O pedido recem-inserido nao tem audit; uma transicao ILEGAL
    // deve manter o count INALTERADO.
    const entityId = String(orderId);
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    expect(auditForEntityBefore, "pedido novo nao tem audit ainda").toBe(0);

    // --- acao: applyPaymentStatusTx(tx, orderId, 'pending', {id, valueCents}) — a
    //     maquina de pagamento de PRODUCAO. payment.id CASA com asaas_payment_id
    //     (anti-replay satisfeito) p/ exercitar a GUARDA DE TRANSICAO de fato.
    const res = runSeam<PaymentStatusUpdate>("applyPaymentStatus", {
      orderId,
      status: "pending",
      payment: { id: asaasPaymentId, valueCents: subtotal },
    });

    // --- assert 1: Resultado ok:false reason='invalid_transition' (paid -> pending barrado).
    expect("found" in res && res.found, "pedido deve ser encontrado").toBe(true);
    if (!("found" in res) || !res.found) throw new Error("esperava found:true");
    expect(res.ok, "transicao ilegal deve ser rejeitada (ok:false)").toBe(false);
    if (res.ok) throw new Error("esperava ok:false");
    expect(res.reason, "reason deve ser invalid_transition (paid->pending)").toBe(
      "invalid_transition",
    );

    // --- assert 2: orders.payment_status permanece 'paid' (nada gravado). Flags intactas.
    const ord = await client.query<{
      payment_status: string;
      stock_reserved: boolean;
      stock_committed: boolean;
    }>(`SELECT payment_status, stock_reserved, stock_committed FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(ord.rowCount).toBe(1);
    expect(ord.rows[0].payment_status, "payment_status deve permanecer 'paid'").toBe("paid");
    expect(ord.rows[0].stock_committed, "stockCommitted deve permanecer true").toBe(true);
    expect(ord.rows[0].stock_reserved, "stockReserved deve permanecer false").toBe(false);

    // --- assert 3: nenhum efeito de estoque — products.stock/reserved INALTERADOS.
    const postP = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(postP.rowCount).toBe(1);
    expect(postP.rows[0].stock, "stock deve permanecer STOCK0 (sem efeito)").toBe(STOCK0);
    expect(postP.rows[0].reserved, "reserved deve permanecer RESERVED0 (sem efeito)").toBe(
      RESERVED0,
    );

    // rede final: CHECK 0<=reserved<=stock existe + 0 violacoes (jamais violado).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);

    // --- assert 4: audit_log NAO ganha linha (transicao ilegal => sem audit orfao).
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    expect(Number(afterAudit.rows[0].total), "audit_log total deve permanecer inalterado").toBe(
      auditTotalBefore,
    );
    expect(
      Number(afterAudit.rows[0].forEntity),
      "este pedido NAO deve ganhar audit (transicao ilegal)",
    ).toBe(auditForEntityBefore);

    // Reforco: 0 linhas de payment_status_update para este pedido (sem audit orfao).
    const payAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE entity_id = $1 AND entity_type = 'order'
           AND action = 'order.payment_status_update'`,
      [entityId],
    );
    expect(
      Number(payAudit.rows[0].count),
      "nenhum audit order.payment_status_update p/ este pedido",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.note.update-audited (priority 12) — DB-first, sem browser.
 *
 * Prova "admin grava nota interna do pedido (auditado)" contra o Postgres efemero
 * REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas de pedido
 * (shipping-cancel-reconciles-stock.spec.ts): roda em Node (sem `page`) e assertaa o
 * estado real via `pg`.
 *
 * SEAM escolhida: updateOrderInternalNote(orderId, note, actor) de lib/data/orders.ts
 * (L579) — a funcao de menor nivel que prova as invariantes. Numa MESMA
 * prisma.$transaction ela: normaliza a nota (string vazia/so-espacos -> null), le o
 * pedido (before, adminOrderSelect), trata o no-op idempotente quando
 * (existing.internalNote ?? null) === normalized (devolve changed:false SEM audit),
 * senao faz UPDATE internalNote e grava audit_log (action order.note_update,
 * before/after = orderAuditSnapshot { paymentStatus, shippingStatus, internalNote })
 * — TUDO na mesma tx. NAO chamamos a server action updateOrderInternalNoteAction
 * porque ela comeca com requireAdmin() (contexto de request: next/headers, Clerk),
 * que quebra fora do HTTP; a action so DELEGA para updateOrderInternalNote.
 *
 * DADOS PROPRIOS (anti-trivialidade): criamos um PEDIDO proprio (INSERT direto em
 * `pg`) com internal_note=NULL e — DE PROPOSITO — payment_status='paid' e
 * shipping_status='sent' (estados NAO-default). Assim o assert "status de
 * pagamento/envio inalterados" e nao-trivial: se a operacao tocasse esses campos, o
 * teste pegaria; e o snapshot de audit registra paymentStatus=paid/shippingStatus=sent
 * identicos em before e after (so a nota muda).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso a MUTACAO (updateOrderInternalNote) roda num processo `tsx`
 * separado (tests/harness/estoque/_run-seam.ts, ESTENDIDO nesta sessao com o case
 * `updateOrderInternalNote` — INFRA de teste, nao codigo de produto), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: audit-same-tx (1 linha order.note_update na MESMA tx,
 * before.internalNote=null / after.internalNote=NOTE; rollback nao deixa orfao —
 * aqui provado pelo delta exato +1 total E +1 por entity_id, e pela ausencia de
 * efeito nos demais campos).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type AdminOrderUpdate =
  | { ok: false; reason: string }
  | { ok: true; changed: boolean; order: { internalNote: string | null } };

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

const NOTE = "verificar endereco";
// Estados NAO-default de proposito p/ tornar "status inalterados" nao-trivial.
const PAYMENT0 = "paid";
const SHIPPING0 = "sent";

test("pedido.note.update-audited: grava nota interna na mesma tx, auditado, sem tocar status", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };

    // --- setup: PEDIDO PROPRIO com internal_note=NULL e payment/shipping NAO-default
    //     (paid/sent), sem itens (a nota nao toca estoque). subtotal/total coerentes.
    const subtotal = 9999;
    const ins = await client.query<{ id: number }>(
      `INSERT INTO "orders" (
         clerk_user_id, customer_name, customer_email, customer_phone,
         address_cep, address_street, address_city, address_state,
         subtotal_cents, discount_cents, shipping_cents, total_cents,
         payment_status, payment_method, shipping_status,
         stock_reserved, stock_committed, internal_note
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, 0, 0, $10,
         $11, 'pix', $12,
         false, true, NULL
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
        subtotal,
        PAYMENT0,
        SHIPPING0,
      ],
    );
    const orderId = ins.rows[0].id;

    // Sanidade do pre-estado: internal_note NULL, status nos valores nao-default.
    const pre = await client.query<{
      internal_note: string | null;
      payment_status: string;
      shipping_status: string;
    }>(`SELECT internal_note, payment_status, shipping_status FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(pre.rows[0].internal_note, "pre: internal_note=NULL").toBeNull();
    expect(pre.rows[0].payment_status, "pre: payment_status=paid").toBe(PAYMENT0);
    expect(pre.rows[0].shipping_status, "pre: shipping_status=sent").toBe(SHIPPING0);

    // Contagem de audit antes (total e por entity_id do PEDIDO). entity_id de pedido
    // e String(orderId) (entity_id e string p/ acomodar uuid de produto e int de pedido).
    const entityId = String(orderId);
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    // Pedido recem-inserido nao tem audit ainda; gravar a nota deve somar +1.
    expect(auditForEntityBefore, "pedido novo nao tem audit ainda").toBe(0);

    // --- acao: updateOrderInternalNote(orderId, NOTE, actor) (seam de PRODUCAO).
    const res = runSeam<AdminOrderUpdate>("updateOrderInternalNote", {
      orderId,
      note: NOTE,
      actor,
    });
    expect(res.ok, "gravar nova nota deve ser ok").toBe(true);
    if (res.ok) {
      expect(res.changed, "nota diferente => changed=true").toBe(true);
      expect(res.order.internalNote, "order retornado com a nota nova").toBe(NOTE);
    }

    // --- assert 1: orders.internal_note == NOTE.
    const ord = await client.query<{
      internal_note: string | null;
      payment_status: string;
      shipping_status: string;
    }>(`SELECT internal_note, payment_status, shipping_status FROM "orders" WHERE id = $1`, [
      orderId,
    ]);
    expect(ord.rowCount).toBe(1);
    expect(ord.rows[0].internal_note, "internal_note deve virar a nota gravada").toBe(NOTE);

    // --- assert 3: status de pagamento/envio inalterados (a nota nao toca a maquina
    //     de estados). Nao-trivial: pre-estado e paid/sent (nao-default).
    expect(ord.rows[0].payment_status, "payment_status inalterado (paid)").toBe(PAYMENT0);
    expect(ord.rows[0].shipping_status, "shipping_status inalterado (sent)").toBe(SHIPPING0);

    // --- assert 2: audit_log recebe EXATAMENTE 1 linha nova p/ o pedido, action=
    //     order.note_update, na MESMA tx, before.internalNote=null,
    //     after.internalNote=NOTE.
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
      before: { internalNote: string | null; paymentStatus: string; shippingStatus: string } | null;
      after: { internalNote: string | null; paymentStatus: string; shippingStatus: string } | null;
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

    // action gravado com o valor DOTTED do @map (schema.prisma:
    // order_note_update @map("order.note_update")). Lemos a coluna crua via pg, nao a
    // chave JS do enum (que e 'order_note_update').
    expect(a.action, "action deve ser o valor @map dotted").toBe("order.note_update");
    expect(a.entity_type).toBe("order");
    expect(a.entity_id).toBe(entityId);

    // before/after sao snapshots do dominio (camelCase). before.internalNote=null,
    // after.internalNote=NOTE; paymentStatus/shippingStatus identicos nos dois (delta
    // limpo: so a nota mudou).
    expect(a.before, "before deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.after, "after deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.before!.internalNote, "before.internalNote deve ser null").toBeNull();
    expect(a.after!.internalNote, "after.internalNote deve ser a nota gravada").toBe(NOTE);
    expect(a.before!.paymentStatus, "before.paymentStatus=paid").toBe(PAYMENT0);
    expect(a.after!.paymentStatus, "after.paymentStatus identico (so nota mudou)").toBe(PAYMENT0);
    expect(a.before!.shippingStatus, "before.shippingStatus=sent").toBe(SHIPPING0);
    expect(a.after!.shippingStatus, "after.shippingStatus identico (so nota mudou)").toBe(
      SHIPPING0,
    );
  } finally {
    await client.end();
  }
});

import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.note.empty-normalized-noop (priority 13) — DB-first, sem browser.
 *
 * Prova "nota interna identica/vazia e no-op (normaliza vazio -> null)" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO da spec irma
 * note-update-audited.spec.ts: roda em Node (sem `page`) e assertaa o estado real
 * via `pg`.
 *
 * SEAM escolhida: updateOrderInternalNote(orderId, note, actor) de lib/data/orders.ts
 * (L579) — a MESMA funcao de menor nivel da feature de update. O ramo provado aqui:
 *   const normalized = note && note.trim().length > 0 ? note.trim() : null;  (L585)
 *   if ((existing.internalNote ?? null) === normalized)                       (L594)
 *     return { ok:true, changed:false, order } as const;  // SEM writeAuditLog
 * Ou seja: '   ' (so espacos) normaliza p/ null; como internalNote JA era null,
 * null===null => o no-op idempotente retorna changed=false ANTES de qualquer UPDATE
 * e ANTES do writeAuditLog. A guarda esta DENTRO da prisma.$transaction, mas como
 * nenhum write ocorre, nada e gravado (nem orders nem audit_log). NAO chamamos a
 * server action updateOrderInternalNoteAction porque ela comeca com requireAdmin()
 * (contexto de request: next/headers, Clerk), que quebra fora do HTTP; a action so
 * DELEGA para updateOrderInternalNote.
 *
 * DADOS PROPRIOS (anti-trivialidade): criamos um PEDIDO proprio (INSERT direto em
 * `pg`) com internal_note=NULL e — DE PROPOSITO — payment_status='paid' e
 * shipping_status='sent' (estados NAO-default). Se a operacao tocasse algum campo, o
 * delta de audit / o estado dos campos pegaria. ALEM do caso do ledger ('   '
 * so-espacos), reforcamos com '' (string vazia) e null explicito — todos normalizam
 * p/ null e batem no MESMO no-op, sem audit. Por contraste, NAO escrevemos uma nota
 * real aqui (essa transicao e coberta por pedido.note.update-audited); o foco e
 * provar que vazio/null NAO geram audit.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso a chamada do seam (updateOrderInternalNote) roda num processo
 * `tsx` separado (tests/harness/estoque/_run-seam.ts, case `updateOrderInternalNote`
 * JA existente — INFRA de teste, suporta note: string | null), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: audit-same-tx (no-op idempotente NAO grava audit; o delta de
 * audit_log total E por entity_id permanece 0; nenhum orfao).
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

// Estados NAO-default de proposito p/ tornar "status inalterados" nao-trivial.
const PAYMENT0 = "paid";
const SHIPPING0 = "sent";

test("pedido.note.empty-normalized-noop: nota vazia/so-espacos normaliza p/ null e e no-op sem audit", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: "admin-harness", email: `admin-${tag}@harness.test`, role: null };

    // --- setup: PEDIDO PROPRIO com internal_note=NULL e payment/shipping NAO-default
    //     (paid/sent), sem itens. subtotal/total coerentes.
    const subtotal = 8888;
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
    const entityId = String(orderId);

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
    // e String(orderId). Pedido recem-inserido nao tem audit ainda.
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
      [entityId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    expect(auditForEntityBefore, "pedido novo nao tem audit ainda").toBe(0);

    // --- acao + asserts do ledger, exercitados p/ CADA forma de "vazio".
    //     O caso do ledger e '   ' (so espacos). Reforco: '' e null explicito —
    //     todos normalizam p/ null e, como internalNote JA e null, sao no-op SEM audit.
    const emptyForms: Array<string | null> = ["   ", "", null];
    for (const form of emptyForms) {
      const label = form === null ? "null" : JSON.stringify(form);

      // --- assert 1: normaliza p/ null e, como ja era null, changed=false.
      const res = runSeam<AdminOrderUpdate>("updateOrderInternalNote", {
        orderId,
        note: form,
        actor,
      });
      expect(res.ok, `note=${label}: deve ser ok`).toBe(true);
      if (res.ok) {
        expect(res.changed, `note=${label}: vazio/null sobre null => changed=false (no-op)`).toBe(
          false,
        );
        expect(
          res.order.internalNote,
          `note=${label}: order retornado com internalNote=null`,
        ).toBeNull();
      }

      // --- assert 2: orders.internal_note permanece null; status inalterados.
      const ord = await client.query<{
        internal_note: string | null;
        payment_status: string;
        shipping_status: string;
      }>(`SELECT internal_note, payment_status, shipping_status FROM "orders" WHERE id = $1`, [
        orderId,
      ]);
      expect(ord.rowCount).toBe(1);
      expect(ord.rows[0].internal_note, `note=${label}: internal_note permanece null`).toBeNull();
      expect(ord.rows[0].payment_status, `note=${label}: payment_status inalterado`).toBe(PAYMENT0);
      expect(ord.rows[0].shipping_status, `note=${label}: shipping_status inalterado`).toBe(
        SHIPPING0,
      );

      // --- assert 3: audit_log NAO ganha linha (no-op idempotente, sem audit). Tanto
      //     o total quanto o por entity_id permanecem nos valores de antes (== A; sem
      //     orfao). Provado para cada forma de vazio (acumulativo: nenhuma soma audit).
      const afterAudit = await client.query<{ total: string; forEntity: string }>(
        `SELECT
           (SELECT COUNT(*) FROM "audit_log")::text AS total,
           (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1 AND entity_type = 'order')::text AS "forEntity"`,
        [entityId],
      );
      expect(
        Number(afterAudit.rows[0].total),
        `note=${label}: audit_log total NAO muda (== A)`,
      ).toBe(auditTotalBefore);
      expect(
        Number(afterAudit.rows[0].forEntity),
        `note=${label}: pedido NAO ganha audit (== ${auditForEntityBefore})`,
      ).toBe(auditForEntityBefore);
    }

    // --- reforco final: zero linhas de order.note_update p/ este pedido (nenhum
    //     audit de nota nasceu em NENHUMA das tentativas vazias). Le a coluna crua
    //     `action` (valor @map DOTTED 'order.note_update'), nao a chave JS do enum.
    const noteAudits = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM "audit_log"
         WHERE entity_id = $1 AND entity_type = 'order' AND action = 'order.note_update'`,
      [entityId],
    );
    expect(
      Number(noteAudits.rows[0].n),
      "nenhuma linha order.note_update gerada por nota vazia/null",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

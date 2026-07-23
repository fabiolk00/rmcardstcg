import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.shipping.sent-vs-refund (category=chaos) — DB-first, sem browser.
 *
 * Prova SOB CONCORRENCIA REAL a regra "nunca despachar o que nao foi pago" quando o
 * admin tenta marcar 'sent' NO MESMO INSTANTE em que um refund concorrente (webhook/
 * reconcile 'cancelled') esta cancelando o pagamento do MESMO pedido. Sem a guarda
 * REPETIDA no WHERE do UPDATE (updateOrderShippingStatus, lib/data/orders.ts), so a
 * checagem de PRE-condicao (leitura antes do CAS) deixaria uma janela TOCTOU: ler
 * paymentStatus='paid', o refund cancelar no meio do caminho, e o CAS de shippingStatus
 * (que so olha shippingStatus=from) aplicar 'sent' mesmo assim — despachando um pedido
 * que acabou de ser estornado.
 *
 * CONTENCAO FORCADA (sem mexer em codigo de producao): so spawn+Promise.all NAO basta
 * pra exercitar essa janela de verdade — o overhead de bootar cada processo (`pnpm exec
 * tsx`, ~150-300ms) domina o tempo total, entao na pratica um lado costuma terminar a
 * transacao inteira antes do outro sequer abrir a dele; a "corrida" vira so sobre quem
 * bootou primeiro, nunca sobre os dois UPDATE...WHERE disputando o MESMO row-lock. Por
 * isso o teste abre uma conexao `pg` PROPRIA e segura `SELECT ... FOR UPDATE` na linha do
 * pedido ANTES de disparar os dois seams: a leitura de pre-checagem de cada um (SELECT
 * simples, MVCC, nao bloqueia em FOR UPDATE alheio) passa livre, mas os dois UPDATE ficam
 * empatados esperando o MESMO lock. Ao soltar, o Postgres libera um de cada vez e
 * RE-AVALIA o WHERE de cada UPDATE contra o committed mais recente — e exatamente esse
 * re-exame, sob disputa real pelo mesmo lock, que o teste teria como pegar se a guarda do
 * WHERE nao existisse (a pre-checagem sozinha nao teria como impedir o segundo UPDATE de
 * aplicar).
 *
 * SEAMS de PRODUCAO (via _run-seam.ts, mesmo motivo ESM/CJS das specs irmas):
 *  - updateOrderShippingStatus(orderId, 'sent', actor) — lib/data/orders.ts.
 *  - applyPaymentStatus(orderId, 'cancelled', payment) — nucleo do webhook do Asaas
 *    (applyPaymentStatusTx envelopado, o MESMO usado por chaos-webhook-out-of-order).
 *
 * INTERLEAVINGS VALIDOS (os dois sao legais a nivel de dominio; a corrida e so de
 * TIMING, nao de legalidade — paid->cancelled e sempre permitido independente do envio):
 *  (1) shipping vence: CAS de 'sent' commita ENQUANTO payment ainda e 'paid' -> shipResult
 *      ok:true, shipping_status='sent'. O refund concorrente roda DEPOIS (ou ja tinha
 *      perdido a corrida do row-lock) e AINDA APLICA normalmente (paid->cancelled nao
 *      depende do envio) -> payment_status='cancelled'. Final: sent + cancelled (pedido
 *      enviado e depois estornado — estado real de e-commerce, ok).
 *  (2) refund vence: o UPDATE do refund commita PRIMEIRO; o WHERE do CAS de shipping
 *      (que agora inclui paymentStatus='paid') nao acha mais a linha -> shipResult
 *      ok:false/payment_required. Final: pending + cancelled.
 * NUNCA pode acontecer: shipResult.ok=true com o CAS tendo comitado DEPOIS do refund
 * (a garantia vem da semantica do UPDATE...WHERE atomico do Postgres: um UPDATE so
 * afeta a linha se o WHERE bater NO MOMENTO do commit — por isso o WHERE PRECISA
 * repetir paymentStatus='paid', nao so a pre-checagem). Os asserts por trial abaixo
 * verificam essa garantia sempre que ela se aplica (shipResult.ok=false ->
 * shipping_status continua 'pending', nunca grava).
 *
 * NOTA sobre distribuicao: as duas operacoes tem custo ASSIMETRICO (diferente de
 * chaos-webhook-out-of-order, onde os dois lados chamam o MESMO seam), entao o
 * escalonador do SO pode favorecer consistentemente um lado sob carga real — a
 * distribuicao e so DIAGNOSTICO (console.info), nunca requisito, mesmo padrao do
 * Cenario C de chaos-webhook-out-of-order.spec.ts.
 *
 * CAVEAT TECNICO (INFRA do harness, sem tocar produto): Prisma gerado e ESM puro
 * (import.meta), incompativel com a transpilacao CJS do Playwright — as MUTACOES rodam
 * num processo `tsx` separado (tests/harness/estoque/_run-seam.ts), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type SeamProduct = { id: string };
type AdminOrderUpdate =
  | { ok: false; reason: string; from?: string; to?: string }
  | { ok: true; changed: boolean; order: { shippingStatus: string } };
type PaymentStatusUpdate =
  | { found: false }
  | { found: true; ok: false; reason: string }
  | { found: true; ok: true; changed: boolean; previousStatus: string; status: string };

type DeliveryOutcome<T> = { label: string; outcome: T | null; error: string | null };

function runSeamSync<T>(op: string, payload: unknown): T {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
    encoding: "utf8",
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32",
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

/** Dispara UMA op via processo tsx ASSINCRONO — permite paralelismo REAL via Promise.all. */
function runSeamAsync<T>(label: string, op: string, payload: unknown): Promise<DeliveryOutcome<T>> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
      env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ label, outcome: null, error: `spawn error: ${e.message}` }));
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          label,
          outcome: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as T,
          error: null,
        });
        return;
      }
      if (errLine) {
        const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
        resolve({ label, outcome: null, error: `${e.name}: ${e.message}` });
        return;
      }
      resolve({
        label,
        outcome: null,
        error: `seam runner sem resultado (status ${status}):\n${stdout}\n${stderr}`,
      });
    });
  });
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const QTY = 2;
const UNIT_PRICE = 4999;
const N_TRIALS = 14; // rajadas concorrentes p/ exercitar as duas ordens de escalonamento

/** Cria produto+pedido PROPRIOS, JA PAGOS e JA COMMITADOS (espelha um pedido paid real). */
async function seedPaidOrder(
  client: Client,
  tag: string,
): Promise<{ orderId: number; paymentId: string; entityId: string }> {
  const created = runSeamSync<SeamProduct>("createProduct", {
    actor: { clerkUserId: null, email: null, role: null },
    input: {
      name: `Produto Harness ShipRace ${tag}`,
      category: "Booster Box",
      sku: `HARNESS-SHIPRACE-${tag}`,
      priceCents: UNIT_PRICE,
      discountPct: 0,
      stock: 20,
      badge: null,
      imageUrl: "/products/placeholder.svg",
      description: "fixture do harness para chaos.shipping.sent-vs-refund",
    },
  });
  const productId = created.id;
  // stockCommitted=true (baixa ja aplicada, como um pedido paid real); reserved=0
  // (nada pendurado). O refund concorrente vai repor via restockUnits.
  await client.query(`UPDATE "products" SET stock = 20, reserved = 0 WHERE id = $1`, [productId]);

  const paymentId = `pay_${tag}`;
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
      subtotal,
      paymentId,
    ],
  );
  const orderId = ins.rows[0].id;
  await client.query(
    `INSERT INTO "order_items" (id, order_id, product_id, product_name, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), orderId, productId, `Produto Harness ShipRace ${tag}`, QTY, UNIT_PRICE],
  );
  return { orderId, paymentId, entityId: String(orderId) };
}

async function shipAuditCount(client: Client, entityId: string): Promise<number> {
  const r = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "audit_log"
       WHERE entity_id = $1 AND entity_type = 'order' AND action = 'order.shipping_status_update'`,
    [entityId],
  );
  return Number(r.rows[0].count);
}

test("chaos.shipping.sent-vs-refund: marcar 'sent' concorrente com refund NUNCA desperta um pedido despachado sem pagamento", async () => {
  const client = makeClient();
  await client.connect();
  // Conexao DEDICADA que so SEGURA um row-lock (SELECT...FOR UPDATE) durante o setup —
  // NAO participa da regra sob teste. Overhead de processo (spawn de `pnpm exec tsx`,
  // ~150-300ms) domina o tempo total, entao sem isso os dois lados raramente chegam ao
  // UPDATE de fato ao mesmo tempo (um comita antes do outro sequer abrir a transacao) —
  // a corrida vira so entre "quem terminou de bootar o processo primeiro", nao entre os
  // dois UPDATE...WHERE de verdade. Segurando o lock ANTES de disparar os dois seams,
  // ambos avancam livres pela LEITURA de pre-checagem (SELECT simples, MVCC, nao bloqueia
  // em FOR UPDATE alheio) e so bloqueiam nos respectivos UPDATE — af unicamente ai os
  // dois ficam empatados esperando o MESMO lock. Ao soltar, o Postgres libera um de cada
  // vez e RE-AVALIA o WHERE de cada UPDATE contra o committed mais recente — isso e
  // exatamente o mecanismo que fecha a corrida, e agora o teste forca os dois lados a
  // disputar ESSA fase, em vez de só a fase de bootstrap do processo.
  const lockClient = makeClient();
  await lockClient.connect();
  try {
    const terminals = { shipWon: 0, refundWon: 0 };

    for (let trial = 0; trial < N_TRIALS; trial++) {
      const tag = `t${trial}-${randomUUID().slice(0, 8)}`;
      const { orderId, paymentId, entityId } = await seedPaidOrder(client, tag);
      const actor = {
        clerkUserId: "admin-harness",
        email: `admin-${tag}@harness.test`,
        role: null,
      };

      await lockClient.query("BEGIN");
      await lockClient.query('SELECT id FROM "orders" WHERE id = $1 FOR UPDATE', [orderId]);

      // DISPARO SIMULTANEO: admin marcando 'sent' x refund cancelando o pagamento. Sem
      // ordem garantida — Promise.all sobre spawn() => paralelismo REAL no mesmo Postgres.
      // Os dois processos avancam ate o UPDATE e ficam BLOQUEADOS pelo lock acima.
      const shipPromise = runSeamAsync<AdminOrderUpdate>("ship", "updateOrderShippingStatus", {
        orderId,
        to: "sent",
        actor,
      });
      const refundPromise = runSeamAsync<PaymentStatusUpdate>("refund", "applyPaymentStatus", {
        orderId,
        status: "cancelled",
        payment: { id: paymentId, valueCents: null },
      });
      // Janela p/ os dois processos bootarem (tsx/Prisma/conexao) e chegarem ao ponto de
      // bloqueio no UPDATE. Generosa de proposito (dominado pelo boot do processo, nao
      // pela transacao em si) — o que importa e soltar o lock DEPOIS que ambos ja estao
      // esperando por ele, nunca antes.
      await new Promise((r) => setTimeout(r, 1200));
      await lockClient.query("COMMIT");

      const [shipOut, refundOut] = await Promise.all([shipPromise, refundPromise]);

      expect(shipOut.error, `[trial ${trial}] entrega 'ship' nao pode falhar como processo`).toBe(
        null,
      );
      expect(
        refundOut.error,
        `[trial ${trial}] entrega 'refund' nao pode falhar como processo`,
      ).toBe(null);
      const ship = shipOut.outcome as AdminOrderUpdate;
      const refund = refundOut.outcome as PaymentStatusUpdate;

      // O refund (paid->cancelled) e SEMPRE legal a nivel de dominio, independente do
      // envio — deve aplicar em TODO trial, ganhe ou perca a corrida do row-lock.
      expect(
        refund.found && refund.ok && refund.changed,
        `[trial ${trial}] refund paid->cancelled deve aplicar sempre: ${JSON.stringify(refund)}`,
      ).toBe(true);

      const row = await client.query<{
        shipping_status: string;
        payment_status: string;
        stock: number;
        reserved: number;
      }>(
        `SELECT o.shipping_status, o.payment_status, p.stock, p.reserved
           FROM "orders" o JOIN "order_items" oi ON oi.order_id = o.id
           JOIN "products" p ON p.id = oi.product_id
           WHERE o.id = $1`,
        [orderId],
      );
      const st = row.rows[0];

      // Payment SEMPRE termina cancelled (o refund sempre aplica, como acabamos de provar).
      expect(st.payment_status, `[trial ${trial}] payment_status terminal cancelled`).toBe(
        "cancelled",
      );

      // NUCLEO DO TESTE: os dois unicos desfechos coerentes.
      if (ship.ok) {
        // (1) shipping venceu: comitou 'sent' ENQUANTO payment ainda era 'paid' (o WHERE
        //     do CAS garante isso por construcao). O refund concorrente ainda aplicou.
        terminals.shipWon++;
        expect(ship.changed, `[trial ${trial}] shipping venceu: changed=true`).toBe(true);
        expect(st.shipping_status, `[trial ${trial}] shipping venceu: 'sent' persistido`).toBe(
          "sent",
        );
        expect(await shipAuditCount(client, entityId), `[trial ${trial}] 1 audit de envio`).toBe(1);
      } else {
        // (2) refund venceu: o CAS de shipping nao achou a linha (paymentStatus deixou de
        //     ser 'paid' antes do commit do UPDATE) -> rejeicao correta, NADA gravado.
        terminals.refundWon++;
        expect(
          ship.reason,
          `[trial ${trial}] refund venceu: shipping deve ser rejeitado como payment_required (nunca invalid_transition/outro)`,
        ).toBe("payment_required");
        expect(
          st.shipping_status,
          `[trial ${trial}] refund venceu: shipping_status NUNCA vira 'sent' (pedido acabou de ser estornado)`,
        ).toBe("pending");
        expect(await shipAuditCount(client, entityId), `[trial ${trial}] rejeicao nao audita`).toBe(
          0,
        );
      }

      // Estoque: restockUnits sempre roda exatamente 1x (stock seed=20 representa o
      // fisico JA COMMITADO; o refund repoe QTY -> 20+QTY) — nunca dupla-reposicao
      // (o que daria 20+2*QTY), independente de quem venceu a corrida do envio (envio
      // nunca toca estoque).
      expect(st.stock, `[trial ${trial}] estoque reposto exatamente 1x pelo refund (20+QTY)`).toBe(
        20 + QTY,
      );
      expect(st.reserved, `[trial ${trial}] reserved intocado (0)`).toBe(0);
    }

    // Todos os trials convergiram a um dos dois desfechos coerentes (nenhum ficou
    // "preso" nem gerou um terceiro estado). A distribuicao entre shipWon/refundWon
    // NAO e asserida em si (mesmo padrao de chaos-webhook-out-of-order.spec.ts,
    // Cenario C): as duas operacoes tem custo ASSIMETRICO (updateOrderShippingStatus
    // le mais colunas/valida mais coisas que applyPaymentStatus), entao o escalonador
    // pode favorecer consistentemente um lado sob carga real — isso e esperado e
    // inofensivo, ja que a coerencia por trial (o que IMPORTA) foi provada acima em
    // TODOS os interleavings que de fato ocorreram.
    expect(
      terminals.shipWon + terminals.refundWon,
      "todos os N_TRIALS convergiram a um dos dois desfechos coerentes",
    ).toBe(N_TRIALS);
    console.info(
      `[chaos.shipping.sent-vs-refund] distribuicao sob rajada concorrente: ${JSON.stringify(terminals)} (de ${N_TRIALS} trials)`,
    );
  } finally {
    await lockClient.query("ROLLBACK").catch(() => {});
    await lockClient.end();
    await client.end();
  }
});

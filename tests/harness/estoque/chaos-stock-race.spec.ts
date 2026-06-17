import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.stock.race (priority 21, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB CONCORRENCIA REAL que "stock=1 com N reservas concorrentes deixa
 * exatamente 1 vencer, sem oversell" contra o Postgres efemero REAL exposto em
 * process.env.DATABASE_URL pelo runner (scripts/harness-with-ephemeral-pg.ts).
 *
 * SEAM escolhida: reserveStock(tx, items) de lib/data/inventory.ts — a MESMA
 * funcao de PRODUCAO que reserva (reserved += qty SE stock-reserved >= qty,
 * atomica e condicional, em LOTE via $queryRaw). O seam runner (_run-seam.ts, op
 * "reserveStockForOrder") abre uma prisma.$transaction e, na MESMA tx, chama
 * reserveStock E vira a flag Order.stockReserved=true — EXATAMENTE o que o
 * checkout de producao faz (createPendingOrderWithReservation, orders.ts
 * L193-221). Se reserveStock devolve ok:false, o runner lanca ReserveAbort e a
 * transacao inteira sofre ROLLBACK (nada parcial: nem reserved, nem flag do
 * pedido) — espelhando o OutOfStockError do checkout. Sem mock.
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE SEGURO (anti-fake-green):
 * disparamos N>=10 processos `tsx` SIMULTANEOS via `spawn` assincrono +
 * Promise.all — NAO `spawnSync` (que serializaria as chamadas e tornaria o teste
 * trivial). Cada processo abre sua PROPRIA transacao no MESMO Postgres e corre
 * pela unica unidade disponivel (stock=1, reserved=0 => disponivel=1). A unica
 * coisa que impede 2 vencedores e o lock de linha do Postgres no UPDATE
 * condicional `WHERE stock - reserved >= qty` de reserveStock: o 1o UPDATE trava
 * a linha, os outros bloqueiam, e ao reavaliarem o predicado pos-commit do
 * vencedor encontram stock-reserved=0 < 1 e atualizam 0 linhas (ok:false). Se a
 * reserva NAO fosse atomica/condicional (ex.: read-modify-write ingenuo), varios
 * veriam disponivel=1, todos incrementariam, e reserved acabaria > 1 (oversell) —
 * o CHECK products_reserved_le_stock_chk dispararia e/ou reserved>1 vazaria. O
 * teste exige reserved==1 e exatamente 1 ok:true, entao QUALQUER corrida insegura
 * o reprova.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os
 * specs para CJS, onde import.meta e SyntaxError — importar lib/data/lib/db DIRETO
 * no spec quebra no load. Por isso as MUTACOES rodam em processos `tsx` separados
 * (tests/harness/estoque/_run-seam.ts), herdando DATABASE_URL; o spec faz TODAS as
 * assercoes via `pg`.
 *
 * Invariantes cobertas: reserved-le-stock (0<=reserved<=stock; oversell impossivel
 * sob corrida) e reserve-lifecycle-idempotent (a flag Order.stockReserved vira na
 * MESMA tx da reserva; so o vencedor a tem true).
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };
type SeamReserve = { ok: true } | { ok: false; productId: string };

/** Resultado de uma das N reservas concorrentes (correlaciona ok/erro ao pedido). */
type RaceOutcome = {
  orderId: number;
  result: SeamReserve | null;
  error: string | null;
};

/**
 * Chama uma op do seam via processo tsx SINCRONO (setup serial: criar produto).
 * Reaproveita o protocolo __SEAM_RESULT__/__SEAM_ERROR__ das specs irmas.
 */
function runSeamSync<T>(op: "createProduct", payload: unknown): T {
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

/**
 * Chama reserveStockForOrder via processo tsx ASSINCRONO. RETORNA uma Promise que
 * so resolve quando o processo termina — permitindo que N delas rodem em paralelo
 * REAL via Promise.all (cada uma e um processo/transacao independente correndo no
 * MESMO Postgres). Resolve sempre (nunca rejeita) com o resultado do seam ou um
 * erro de processo, para que Promise.all colete TODOS os desfechos da corrida.
 */
function runReserveAsync(
  orderId: number,
  productId: string,
  quantity: number,
): Promise<RaceOutcome> {
  return new Promise<RaceOutcome>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", SEAM_RUNNER, "reserveStockForOrder"], {
      env: {
        ...process.env,
        SEAM_PAYLOAD: JSON.stringify({ orderId, items: [{ productId, quantity }] }),
      },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) =>
      resolve({ orderId, result: null, error: `spawn error: ${e.message}` }),
    );
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          orderId,
          result: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as SeamReserve,
          error: null,
        });
        return;
      }
      if (errLine) {
        const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
        resolve({ orderId, result: null, error: `${e.name}: ${e.message}` });
        return;
      }
      resolve({
        orderId,
        result: null,
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

const N = 12; // reservas concorrentes (>=10, exige o ledger)
const STOCK = 1; // estoque fisico: UMA unica unidade disputada
const QTY = 1; // cada reserva pede 1 unidade

test("chaos.stock.race: N reservas concorrentes em stock=1, exatamente 1 vence (sem oversell)", async () => {
  // N processos tsx concorrentes (cada um sobe um Prisma) sob Windows: folga ampla.
  test.setTimeout(180_000);

  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup A: cria um produto PROPRIO (sem tocar o seed), depois forca
    //     stock=1, reserved=0 (disponivel=1). reserved e gerido pelo ciclo de
    //     reserva (nunca por create/update do produto), entao o UPDATE direto e a
    //     forma honesta de pre-posicionar o estado da corrida.
    const created = runSeamSync<SeamProduct>("createProduct", {
      actor,
      input: {
        name: `Produto Harness Race ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-RACE-${tag}`,
        priceCents: 19990,
        discountPct: 0,
        stock: 50,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para chaos.stock.race",
      },
    });
    const productId = created.id;

    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK,
      0,
      productId,
    ]);

    const pre = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    expect(pre.rows[0].stock, "setup deve deixar stock=1").toBe(STOCK);
    expect(pre.rows[0].reserved, "setup deve deixar reserved=0 (disponivel=1)").toBe(0);
    expect(pre.rows[0].stock - pre.rows[0].reserved, "disponivel inicial = 1").toBe(1);

    // --- setup B: cria N pedidos PROPRIOS, cada um com stockReserved=false. Cada
    //     reserva concorrente reivindica O SEU pedido (orderId distinto), de modo
    //     que "exatamente 1 pedido fica stockReserved=true" seja uma assercao real.
    const orderIds: number[] = [];
    for (let i = 0; i < N; i++) {
      const ins = await client.query<{ id: number }>(
        `INSERT INTO "orders" (
           clerk_user_id, customer_name, customer_email, customer_phone,
           address_cep, address_street, address_city, address_state,
           subtotal_cents, total_cents, payment_method
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          `harness-race-${tag}-${i}`,
          "Harness Race",
          `harness-race-${tag}-${i}@example.com`,
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
      expect(ins.rowCount).toBe(1);
      orderIds.push(ins.rows[0].id);
    }
    expect(orderIds.length, "deve haver N pedidos distintos p/ a corrida").toBe(N);

    // --- ACAO: dispara as N reservas SIMULTANEAS. Promise.all sobre processos
    //     spawn() assincronos => paralelismo REAL: todos os tsx correm ao mesmo
    //     tempo, cada um numa transacao independente, disputando a unica unidade.
    //     NAO ha serializacao artificial (spawnSync seria serial e trivial).
    const outcomes = await Promise.all(
      orderIds.map((orderId) => runReserveAsync(orderId, productId, QTY)),
    );

    // Nenhum processo deve ter morrido de forma inesperada: todo desfecho e ou um
    // resultado de dominio (ok:true/ok:false) ou (no maximo) um deadlock benigno
    // tratado abaixo. Falha de processo/sem-resultado e bug de infra, nao da corrida.
    const processFailures = outcomes.filter((o) => o.result === null);
    expect(
      processFailures,
      `nenhuma das N reservas pode falhar como processo:\n${JSON.stringify(processFailures, null, 2)}`,
    ).toHaveLength(0);

    const winners = outcomes.filter((o) => o.result?.ok === true);
    const losers = outcomes.filter((o) => o.result?.ok === false);

    // --- ASSERT 1: exatamente 1 reserva vence; as N-1 falham graciosamente
    //     ({ok:false, productId}) SEM efeito parcial.
    expect(winners.length, "exatamente 1 reserva deve vencer a corrida (sem oversell)").toBe(1);
    expect(losers.length, "as N-1 reservas perdedoras devem falhar graciosamente").toBe(N - 1);
    for (const l of losers) {
      const r = l.result as { ok: false; productId: string };
      expect(r.ok).toBe(false);
      expect(r.productId, "perdedora aponta o productId sem disponibilidade").toBe(productId);
    }

    // --- ASSERT 2: products.reserved == 1 e products.stock == 1 ao final
    //     (sem oversell: reserved nunca excede stock; reserva nao baixa estoque).
    const after = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].reserved, "reserved final == 1 (exatamente 1 reserva colou)").toBe(1);
    expect(after.rows[0].stock, "stock fisico permanece 1 (reserva nao baixa estoque)").toBe(STOCK);
    expect(Number.isInteger(after.rows[0].reserved)).toBe(true);
    expect(after.rows[0].stock - after.rows[0].reserved, "disponivel final == 0").toBe(0);

    // --- ASSERT 3: o CHECK products_reserved_le_stock_chk NUNCA foi violado. Existe
    //     (a invariante e do BANCO) e nenhuma linha o viola ao final. Reforco: o DB
    //     rejeita por SQL cru qualquer tentativa de reserved > stock (oversell).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);

    let dbRejected = false;
    try {
      await client.query(`UPDATE "products" SET reserved = $1 WHERE id = $2`, [
        STOCK + 1,
        productId,
      ]);
    } catch (e) {
      dbRejected = true;
      expect(String((e as Error).message)).toMatch(/products_reserved_le_stock_chk/);
    }
    expect(dbRejected, "DB deve rejeitar reserved > stock (oversell) por SQL cru").toBe(true);
    // O UPDATE invalido nao persistiu: a linha segue reserved=1, stock=1.
    const finalRow = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(finalRow.rows[0].reserved, "reserved permanece 1 (UPDATE invalido nao colou)").toBe(1);
    expect(finalRow.rows[0].stock).toBe(STOCK);

    // --- ASSERT 4: exatamente 1 pedido fica stockReserved=true; nenhum cria
    //     reserved=2. A flag do pedido vencedor virou na MESMA tx da reserva; as
    //     perdedoras sofreram rollback total (flag intocada). Cruzamos a contagem
    //     no DB com o orderId que o seam reportou como vencedor.
    const reservedOrders = await client.query<{ id: number }>(
      `SELECT id FROM "orders"
         WHERE id = ANY($1::int[]) AND stock_reserved = true`,
      [orderIds],
    );
    expect(reservedOrders.rowCount, "exatamente 1 pedido com stockReserved=true").toBe(1);
    expect(winners[0].orderId, "o pedido marcado e o do vencedor reportado pelo seam").toBe(
      reservedOrders.rows[0].id,
    );
    // Nenhum dos pedidos perdedores ficou committed nem reserved (rollback total).
    const committedOrders = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "orders"
         WHERE id = ANY($1::int[]) AND stock_committed = true`,
      [orderIds],
    );
    expect(
      Number(committedOrders.rows[0].count),
      "nenhum pedido vira committed nesta corrida",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

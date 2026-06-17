import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.checkout.double-submit (priority 31, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB CONCORRENCIA REAL que o double-submit de checkout — o MESMO checkoutKey
 * enviado N vezes em rajada (duplo-clique no botao / retry de rede) — cria EXATAMENTE
 * 1 pedido e reserva o estoque 1x SO, contra o Postgres efemero REAL exposto em
 * process.env.DATABASE_URL pelo runner.
 *
 * SEAM escolhida: createOrderWithReservation(input) de lib/data/orders.ts — a MESMA
 * funcao de PRODUCAO que o checkout chama. Dentro dela vive a idempotencia inteira:
 *  (1) curto-circuito barato findOrderByCheckoutKey ANTES da $transaction (reused:true
 *      se o pedido ja existe);
 *  (2) checkoutKey @unique no DB (orders.checkout_key) — numa MESMA prisma.$transaction
 *      faz reserveStock(tx, items) e tx.order.create({ checkoutKey, ... });
 *  (3) em CORRIDA (os N racers passam o curto-circuito juntos porque ainda nao ha
 *      pedido), exatamente 1 INSERT vence; os demais violam a unique (P2002 em
 *      checkout_key) e o produto RE-LE o vencedor via findOrderByCheckoutKey e devolve
 *      { ok:true, reused:true } — NUNCA cria pedido/cobranca dupla, NUNCA vaza P2002.
 * Como reserveStock corre na MESMA tx do create, o rollback do INSERT perdedor DESFAZ
 * tambem a reserva daquela tentativa: so a reserva do vencedor persiste (reserved += qty
 * 1x). O seam runner (_run-seam.ts, op "createOrderWithReservation") chama a funcao de
 * PRODUCAO direto, sem mock — a server action de checkout so monta o input apos validar
 * carrinho/preco (irrelevante p/ a idempotencia e inacessivel sem o middleware Proxy).
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE IDEMPOTENTE (anti-fake-green):
 * disparamos N>=10 processos `tsx` SIMULTANEOS via `spawn` assincrono + Promise.all —
 * NAO `spawnSync` (que serializaria e tornaria o teste trivial, deixando o curto-circuito
 * resolver tudo). Como NENHUM pedido existe quando a rajada comeca, os N racers passam o
 * findOrderByCheckoutKey (todos veem null) e correm o INSERT do MESMO checkoutKey. A unica
 * coisa que impede N pedidos e a UNIQUE checkout_key + o tratamento de P2002 do produto.
 * Se o produto NAO tratasse a corrida (ex.: sem @unique, ou re-lancando P2002 cru, ou
 * reservando fora da tx do create), teriamos: varias linhas em orders p/ o checkoutKey,
 * reserved incrementado N vezes (reserva dupla -> ate oversell/violacao do CHECK), ou
 * processos morrendo com P2002 vazado. O teste exige 1 unica linha, reserva 1x e todos
 * os desfechos ok:true (1 created + N-1 reused), entao QUALQUER corrida insegura o reprova.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data/lib/db DIRETO no spec quebra no load.
 * Por isso as MUTACOES rodam em processos `tsx` separados (tests/harness/estoque/_run-seam.ts),
 * herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariante coberta: webhook-idempotent (a chave de idempotencia — aqui checkoutKey —
 * colapsa entregas/submissoes repetidas em UM unico efeito: 1 pedido, 1 reserva). Como
 * rede final tambem provamos reserved-le-stock (CHECK 0<=reserved<=stock nunca violado).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type SeamProduct = { id: string };
type SeamOrder = { id: string; checkoutKey?: string | null };
type CreateOrderOk = { ok: true; reused: boolean; order: SeamOrder };
type CreateOrderFail = { ok: false; reason: "out_of_stock"; productId: string };
type CreateOrderResult = CreateOrderOk | CreateOrderFail;

/** Desfecho de uma das N submissoes concorrentes (correlaciona resultado/erro). */
type SubmitOutcome = {
  submitId: number;
  result: CreateOrderResult | null;
  error: string | null;
};

/** Cria produto via processo tsx SINCRONO (setup serial). */
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
 * Submete um checkout via processo tsx ASSINCRONO. RETORNA uma Promise que so resolve
 * quando o processo termina — permitindo que N submissoes rodem em paralelo REAL via
 * Promise.all (cada uma e um processo/transacao independente no MESMO Postgres,
 * processando o MESMO checkoutKey). Resolve sempre (nunca rejeita) com o resultado do
 * seam ou um erro de processo, para que Promise.all colete TODOS os desfechos.
 */
function submitAsync(submitId: number, payload: unknown): Promise<SubmitOutcome> {
  return new Promise<SubmitOutcome>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", SEAM_RUNNER, "createOrderWithReservation"], {
      env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) =>
      resolve({ submitId, result: null, error: `spawn error: ${e.message}` }),
    );
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          submitId,
          result: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as CreateOrderResult,
          error: null,
        });
        return;
      }
      if (errLine) {
        const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
        resolve({ submitId, result: null, error: `${e.name}: ${e.message}` });
        return;
      }
      resolve({
        submitId,
        result: null,
        error: `seam runner sem resultado (status ${status}):\n${stdout}\n${stderr}`,
      });
    });
  });
}

/** Submissao SINCRONA (reenvio tardio/idempotente apos a corrida ter assentado). */
function submitSync(payload: unknown): CreateOrderResult {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, "createOrderWithReservation"], {
    encoding: "utf8",
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32",
  });
  const out = `${r.stdout ?? ""}`;
  const okLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
  const errLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
  if (errLine) {
    const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
    throw new Error(`${e.name}: ${e.message}`);
  }
  if (!okLine) throw new Error(`seam runner sem resultado:\n${out}\n${r.stderr ?? ""}`);
  return JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as CreateOrderResult;
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const N = 12; // submissoes concorrentes do MESMO checkoutKey (>=10, exige o ledger/unique)
const STOCK = 50; // estoque fisico amplo (a corrida e de IDEMPOTENCIA, nao de oversell)
const RESERVED_OTHER = 3; // reserva PRE-EXISTENTE de outro pedido (anti-trivial: >0, intocada)
const QTY = 2; // quantidade do pedido (1 item) — a reserva esperada e += QTY 1x
const UNIT_CENTS = 4990; // preco unitario (Int em centavos)
const SUBTOTAL_CENTS = QTY * UNIT_CENTS;
const SHIPPING_CENTS = 2500;
const TOTAL_CENTS = SUBTOTAL_CENTS + SHIPPING_CENTS;

test("chaos.checkout.double-submit: N submissoes do MESMO checkoutKey criam 1 pedido (reserva 1x)", async () => {
  // N processos tsx concorrentes (cada um sobe um Prisma) sob Windows: folga ampla.
  test.setTimeout(240_000);

  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup A: cria produto PROPRIO (createProduct de PRODUCAO), depois forca
    //     stock=STOCK, reserved=RESERVED_OTHER (>0, de OUTRO pedido). reserved e gerido
    //     pelo ciclo de reserva; pre-posicionar via SQL e a forma honesta de montar a
    //     pre-condicao. RESERVED_OTHER>0 prova que a reserva alheia NUNCA e tocada e que
    //     a reserva do nosso checkout e EXATAMENTE += QTY (anti-trivial).
    const created = runSeamSync<SeamProduct>("createProduct", {
      actor,
      input: {
        name: `Produto Harness DoubleSubmit ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-DSUB-${tag}`,
        priceCents: UNIT_CENTS,
        discountPct: 0,
        stock: STOCK,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para chaos.checkout.double-submit",
      },
    });
    const productId = created.id;

    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK,
      RESERVED_OTHER,
      productId,
    ]);
    const pre = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    expect(pre.rows[0].stock, "setup deve deixar stock=STOCK").toBe(STOCK);
    expect(pre.rows[0].reserved, "setup deve deixar reserved=RESERVED_OTHER (>0)").toBe(
      RESERVED_OTHER,
    );

    // --- setup B: checkoutKey FIXO p/ a rajada. NENHUM pedido existe ainda — os N racers
    //     passam juntos o curto-circuito findOrderByCheckoutKey (todos veem null) e
    //     correm o INSERT do MESMO checkout_key. Isto exercita GENUINAMENTE a colisao na
    //     UNIQUE (e nao apenas o curto-circuito barato).
    const checkoutKey = `chk_${tag}`;
    const userId = `harness-dsub-${tag}`;

    const preOrders = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "orders" WHERE checkout_key = $1`,
      [checkoutKey],
    );
    expect(Number(preOrders.rows[0].count), "nenhum pedido p/ o checkoutKey antes da rajada").toBe(
      0,
    );

    const payload = {
      input: {
        checkoutKey,
        userId,
        customerName: "Harness DoubleSubmit",
        customerEmail: `${userId}@example.com`,
        customerPhone: "(41) 90000-0000",
        address: { cep: "80000-000", street: "Rua Teste", city: "Curitiba", state: "PR" },
        items: [
          {
            productId,
            productName: `Produto Harness DoubleSubmit ${tag}`,
            quantity: QTY,
            unitPriceCents: UNIT_CENTS,
          },
        ],
        subtotalCents: SUBTOTAL_CENTS,
        discountCents: 0,
        couponCode: null,
        couponDiscountCents: 0,
        shippingCents: SHIPPING_CENTS,
        totalCents: TOTAL_CENTS,
        paymentMethod: "PIX",
      },
    };

    // --- ACAO: dispara as N submissoes SIMULTANEAS do MESMO checkoutKey. Promise.all
    //     sobre processos spawn() assincronos => paralelismo REAL: todos os tsx correm ao
    //     mesmo tempo, cada um numa transacao independente, disputando o INSERT da chave
    //     unica. NAO ha serializacao artificial (spawnSync seria serial e trivial).
    const outcomes = await Promise.all(
      Array.from({ length: N }, (_unused, i) => submitAsync(i, payload)),
    );

    // Nenhuma submissao pode vazar erro: o double-submit DEVE ser idempotente — o
    // perdedor da corrida que colide na UNIQUE checkout_key tem que ser recuperado pelo
    // produto (catch de P2002 -> findOrderByCheckoutKey -> { ok:true, reused:true }),
    // NUNCA estourar a PrismaClientKnownRequestError (P2002) p/ o chamador. Se este
    // assert falha com "Unique constraint failed on the fields: (checkout_key)", o
    // checkout NAO sobrevive ao duplo-clique: o usuario ve um erro em vez de reaproveitar
    // o pedido — BUG REAL de idempotencia (needs_product_fix).
    const processFailures = outcomes.filter((o) => o.result === null);
    expect(
      processFailures,
      `nenhuma submissao pode vazar erro (P2002 deve virar reused:true):\n${JSON.stringify(
        processFailures,
        null,
        2,
      )}`,
    ).toHaveLength(0);

    // Todos os desfechos sao ok:true (1 created + N-1 reused). Nenhum out_of_stock
    // (estoque amplo) e nenhum P2002 vazado.
    const oks = outcomes.filter((o) => o.result?.ok === true) as Array<
      SubmitOutcome & { result: CreateOrderOk }
    >;
    expect(
      oks.length,
      "todas as N submissoes retornam ok:true (idempotente, sem P2002 vazado)",
    ).toBe(N);
    const created2 = oks.filter((o) => o.result.reused === false);
    const reused = oks.filter((o) => o.result.reused === true);

    // --- ASSERT 1 (idempotente / asserts#1): EXATAMENTE 1 submissao cria o pedido
    //     (reused:false); as N-1 colidem na UNIQUE checkout_key e voltam reused:true,
    //     apontando o MESMO pedido (sem P2002 vazado). A 2a submissao e tratada como
    //     idempotente.
    expect(created2.length, "exatamente 1 submissao CRIA o pedido (reused:false)").toBe(1);
    expect(reused.length, "as N-1 submissoes restantes sao idempotentes (reused:true)").toBe(N - 1);
    // Todas as N submissoes referenciam o MESMO order.id (o vencedor).
    const winnerOrderId = created2[0].result.order.id;
    for (const o of oks) {
      expect(o.result.order.id, "todas as submissoes referenciam o MESMO pedido").toBe(
        winnerOrderId,
      );
    }

    // --- ASSERT 2 (1 unica linha / asserts#2): orders tem EXATAMENTE 1 linha p/ o
    //     checkout_key (UNIQUE colapsa o double-submit num unico pedido).
    const orderRows = await client.query<{ id: number; payment_status: string }>(
      `SELECT id, payment_status FROM "orders" WHERE checkout_key = $1`,
      [checkoutKey],
    );
    expect(orderRows.rowCount, "exatamente 1 linha em orders p/ o checkout_key").toBe(1);
    const dbOrderId = orderRows.rows[0].id;
    expect(String(dbOrderId), "o pedido no DB e o vencedor reportado pelo seam").toBe(
      winnerOrderId,
    );
    expect(orderRows.rows[0].payment_status, "pedido criado fica pending").toBe("pending");

    // 1 unica linha de itens p/ o pedido (sem duplicacao de itens pela corrida).
    const itemRows = await client.query<{ count: string; qty: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(SUM(quantity),0)::text AS qty
         FROM "order_items" WHERE order_id = $1`,
      [dbOrderId],
    );
    expect(Number(itemRows.rows[0].count), "1 unica linha de order_items p/ o pedido").toBe(1);
    expect(Number(itemRows.rows[0].qty), "quantidade do item == QTY (sem duplicar)").toBe(QTY);

    // O pedido criado ja nasce com stockReserved=true e stockCommitted=false (reserva
    // feita na MESMA tx do create).
    const orderFlags = await client.query<{ stock_reserved: boolean; stock_committed: boolean }>(
      `SELECT stock_reserved, stock_committed FROM "orders" WHERE id = $1`,
      [dbOrderId],
    );
    expect(orderFlags.rows[0].stock_reserved, "pedido nasce stockReserved=true").toBe(true);
    expect(orderFlags.rows[0].stock_committed, "pedido nasce stockCommitted=false").toBe(false);

    // --- ASSERT 3 (reserva 1x / asserts#3): products.reserved incrementa pela qty 1x
    //     SO: reserved == RESERVED_OTHER + QTY (a reserva alheia segue intacta; sem
    //     reserva dupla pelos N racers). stock fisico inalterado (reserva nao baixa
    //     estoque). CHECK 0<=reserved<=stock valido.
    const prodAfter = await client.query<{ stock: number; reserved: number }>(
      `SELECT stock, reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(prodAfter.rows[0].reserved, "reserved == RESERVED_OTHER + QTY (reserva 1x so)").toBe(
      RESERVED_OTHER + QTY,
    );
    expect(prodAfter.rows[0].stock, "stock fisico inalterado (reserva nao baixa estoque)").toBe(
      STOCK,
    );
    expect(Number.isInteger(prodAfter.rows[0].reserved)).toBe(true);
    expect(Number.isInteger(prodAfter.rows[0].stock)).toBe(true);

    // --- ASSERT 4 (idempotente apos a corrida / asserts#4): reenviar o MESMO checkoutKey
    //     (reenvio tardio do Asaas / retry de rede apos o pedido existir) NAO cria pedido
    //     novo nem reserva nova — cai no curto-circuito findOrderByCheckoutKey (reused:true).
    const late = submitSync(payload);
    expect(late.ok, "reenvio tardio do MESMO checkoutKey retorna ok:true").toBe(true);
    expect((late as CreateOrderOk).reused, "reenvio tardio e idempotente (reused:true)").toBe(true);
    expect((late as CreateOrderOk).order.id, "reenvio tardio devolve o MESMO pedido").toBe(
      winnerOrderId,
    );

    const ordersFinal = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "orders" WHERE checkout_key = $1`,
      [checkoutKey],
    );
    expect(Number(ordersFinal.rows[0].count), "ainda 1 unica linha p/ o checkout_key").toBe(1);
    const prodFinal = await client.query<{ reserved: number; stock: number }>(
      `SELECT reserved, stock FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(
      prodFinal.rows[0].reserved,
      "reenvio tardio NAO reserva de novo (reserved segue RESERVED_OTHER + QTY)",
    ).toBe(RESERVED_OTHER + QTY);
    expect(prodFinal.rows[0].stock, "stock segue inalterado").toBe(STOCK);

    // --- REDE FINAL: CHECK products_reserved_le_stock_chk existe e 0 linhas o violam
    //     apos toda a rajada + reenvio tardio (reserved-le-stock como rede de seguranca).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
  } finally {
    await client.end();
  }
});

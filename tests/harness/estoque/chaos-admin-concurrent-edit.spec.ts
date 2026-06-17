import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.admin.concurrent-edit (priority 22, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB CONCORRENCIA REAL que "dois updateProduct simultaneos sobre o MESMO
 * produto nao causam lost update" contra o Postgres efemero REAL exposto em
 * process.env.DATABASE_URL pelo runner (scripts/harness-with-ephemeral-pg.ts).
 *
 * SEAM escolhida: updateProduct(actor, id, input) de lib/data/products.ts — a
 * MESMA funcao de PRODUCAO que a server action updateProductAction delega apos
 * requireAdmin(). O seam runner (_run-seam.ts, op "updateProduct") chama a funcao
 * direto: ela abre prisma.$transaction, LE o `before` (findUnique), valida, e faz
 * tx.product.update gravando TODOS os campos editaveis (name, category, sku,
 * priceCents, discountPct, stock, badge, imageUrl, description) + writeAuditLog na
 * MESMA tx. Sem mock.
 *
 * CONCORRENCIA HONESTA (anti-fake-green): disparamos 2 processos `tsx` SIMULTANEOS
 * via `spawn` assincrono + Promise.all — NAO `spawnSync` (que serializaria as
 * chamadas e tornaria o teste trivial). Cada processo abre sua PROPRIA transacao no
 * MESMO Postgres e edita o MESMO produto:
 *   - editor A: muda SO o stock (S -> S+5), carregando os DEMAIS campos no valor
 *     que A leu (discountPct = D original).
 *   - editor B: muda SO o discountPct (D -> 20), carregando os DEMAIS campos no
 *     valor que B leu (stock = S original).
 * Cada updateProduct le o `before` no inicio da SUA transacao e depois sobrescreve
 * a linha INTEIRA com o snapshot que montou. Se as duas transacoes leem o MESMO
 * before (S, D) e cada uma grava a linha completa, a que COMMITAR POR ULTIMO
 * sobrescreve cegamente o campo que a outra mudou (lost update classico): ou
 * stock volta a S (perdendo A) ou discountPct volta a D (perdendo B).
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE SEGURO: o assert central exige
 * que AMBAS as mutacoes (stock=S+5 E discountPct=20) estejam refletidas ao final.
 * Isso so e possivel se updateProduct serializar com seguranca (ex.: SELECT ... FOR
 * UPDATE / optimistic version / read-modify-write sob lock de linha que RE-LE apos
 * adquirir o lock). Um read-modify-write ingenuo sob READ COMMITTED (ler before sem
 * lock, depois UPDATE da linha inteira com o snapshot stale) perde uma das duas
 * edicoes — e o teste reprova honestamente. NAO serializamos as chamadas
 * artificialmente: spawn() + Promise.all dispara as duas de fato em paralelo.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as MUTACOES rodam em processos `tsx` separados
 * (tests/harness/estoque/_run-seam.ts, op "updateProduct" ja existente), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: reserved-le-stock (0<=reserved<=stock permanece valido apos
 * a corrida) e audit-same-tx (cada update aplicado grava 1 linha product.update na
 * MESMA tx; sem audit orfao nem mutacao sem audit).
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = {
  id: string;
  slug: string;
  priceCents: number;
  discountPct: number;
  stock: number;
};

type ProductInput = {
  name: string;
  category: string;
  sku: string;
  priceCents: number;
  discountPct: number;
  stock: number;
  badge: string | null;
  imageUrl: string;
  description: string;
};

/** Desfecho de uma das edicoes concorrentes (ok com produto ou erro de dominio). */
type EditOutcome = {
  label: "A_stock" | "B_discount";
  result: SeamProduct | null;
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
 * Chama updateProduct via processo tsx ASSINCRONO. RETORNA uma Promise que so
 * resolve quando o processo termina — permitindo que as duas rodem em paralelo REAL
 * via Promise.all (cada uma e um processo/transacao independente correndo no MESMO
 * Postgres). Resolve sempre (nunca rejeita): com o produto atualizado, ou com o erro
 * de dominio, ou com um erro de processo, para que Promise.all colete TODOS os
 * desfechos da corrida.
 */
function runUpdateAsync(
  label: EditOutcome["label"],
  id: string,
  input: ProductInput,
): Promise<EditOutcome> {
  return new Promise<EditOutcome>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", SEAM_RUNNER, "updateProduct"], {
      env: {
        ...process.env,
        SEAM_PAYLOAD: JSON.stringify({
          actor: { clerkUserId: null, email: null, role: null },
          id,
          input,
        }),
      },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => resolve({ label, result: null, error: `spawn error: ${e.message}` }));
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          label,
          result: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as SeamProduct,
          error: null,
        });
        return;
      }
      if (errLine) {
        const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
        resolve({ label, result: null, error: `${e.name}: ${e.message}` });
        return;
      }
      resolve({
        label,
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

const BASE_STOCK = 10; // S
const BASE_DISCOUNT = 0; // D
const RESERVED = 3; // reserved>0 p/ deixar reserved-le-stock nao-trivial sob a corrida
const STOCK_DELTA = 5; // editor A: S -> S+5
const NEW_DISCOUNT = 20; // editor B: D -> 20
const BASE_PRICE = 12345; // centavos (Int), nunca corrompido pela corrida

test("chaos.admin.concurrent-edit: 2 updateProduct simultaneos no MESMO produto sem lost update", async () => {
  // 2 processos tsx concorrentes (cada um sobe um Prisma) sob Windows: folga ampla.
  test.setTimeout(120_000);

  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup A: cria um produto PROPRIO (sem tocar o seed) com stock=S, discount=D,
    //     price conhecidos. createProduct nunca aceita reserved (e gerido pelo ciclo
    //     de reserva), entao depois forcamos reserved=R(>0) por UPDATE direto — a unica
    //     forma honesta de deixar reserved>0 neste seam isolado, mantendo o CHECK
    //     reserved-le-stock NAO-trivial durante a corrida.
    const created = runSeamSync<SeamProduct>("createProduct", {
      actor,
      input: {
        name: `Produto Harness ConcEdit ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-CONCEDIT-${tag}`,
        priceCents: BASE_PRICE,
        discountPct: BASE_DISCOUNT,
        stock: BASE_STOCK,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para chaos.admin.concurrent-edit",
      } satisfies ProductInput,
    });
    const productId = created.id;

    await client.query(`UPDATE "products" SET reserved = $1 WHERE id = $2`, [RESERVED, productId]);

    // Le a linha COMPLETA (apos posicionar reserved) p/ reconstruir os inputs
    // identicos: cada editor muda SO o seu campo, carregando os demais no valor lido.
    const seedRow = await client.query<{
      name: string;
      category: string;
      sku: string;
      price_cents: number;
      discount_pct: number;
      stock: number;
      reserved: number;
      badge: string | null;
      image_url: string;
      description: string;
    }>(
      `SELECT name, category, sku, price_cents, discount_pct, stock, reserved,
              badge, image_url, description
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(seedRow.rowCount).toBe(1);
    const p0 = seedRow.rows[0];
    const S = p0.stock;
    const R = p0.reserved;
    const D = p0.discount_pct;
    expect(S, "setup deve deixar stock=S").toBe(BASE_STOCK);
    expect(R, "setup deve deixar reserved=R>0 (nao-trivial)").toBe(RESERVED);
    expect(D, "setup deve deixar discountPct=D").toBe(BASE_DISCOUNT);
    expect(R).toBeGreaterThan(0);

    // Conta audit_log inicial DESTE produto. Esperamos exatamente 1 (o product.create
    // do setup). Cada update aplicado deve somar 1 (audit-same-tx). A corrida deve
    // produzir 2 updates aplicados => +2 (sem audit orfao, sem mutacao sem audit).
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    expect(auditForEntityBefore, "setup criou 1 audit (product.create) p/ este produto").toBe(1);

    // Inputs identicos exceto o campo proprio de cada editor (ambos partem do MESMO
    // before: S, D). Editor A muda SO stock; editor B muda SO discountPct.
    const commonFields = {
      name: p0.name,
      category: p0.category,
      sku: p0.sku,
      badge: p0.badge,
      imageUrl: p0.image_url,
      description: p0.description,
    };
    const inputA: ProductInput = {
      ...commonFields,
      priceCents: p0.price_cents,
      discountPct: D, // A carrega o discount ORIGINAL (stale se B commitar antes)
      stock: S + STOCK_DELTA, // A muda o stock
    };
    const inputB: ProductInput = {
      ...commonFields,
      priceCents: p0.price_cents,
      discountPct: NEW_DISCOUNT, // B muda o discount
      stock: S, // B carrega o stock ORIGINAL (stale se A commitar antes)
    };

    // --- ACAO: dispara as 2 edicoes SIMULTANEAS. Promise.all sobre processos spawn()
    //     assincronos => paralelismo REAL: ambos os tsx correm ao mesmo tempo, cada um
    //     numa transacao independente, editando o MESMO produto. NAO ha serializacao
    //     artificial (spawnSync seria serial e trivial).
    const outcomes = await Promise.all([
      runUpdateAsync("A_stock", productId, inputA),
      runUpdateAsync("B_discount", productId, inputB),
    ]);

    // Nenhum processo deve ter morrido de forma inesperada: cada desfecho e um produto
    // (sucesso) OU um erro de dominio capturado. Falha de processo/sem-resultado e bug
    // de infra, nao da corrida.
    const processFailures = outcomes.filter((o) => o.result === null && o.error !== null);
    expect(
      processFailures,
      `nenhuma das 2 edicoes pode falhar como processo:\n${JSON.stringify(processFailures, null, 2)}`,
    ).toHaveLength(0);

    // Ambas as edicoes sao transicoes legais (stock S+5 >= reserved; discount 20<=80):
    // ambas devem retornar o produto (ok). Quantas de fato aplicaram mutacao e provado
    // pelo audit_log abaixo.
    const succeeded = outcomes.filter((o) => o.result !== null);
    expect(
      succeeded.length,
      `ambas as edicoes legais devem completar com sucesso:\n${JSON.stringify(outcomes, null, 2)}`,
    ).toBe(2);

    // --- ASSERT 1 (central, anti-lost-update): o estado final reflete AMBAS as
    //     mutacoes — stock == S+5 E discountPct == 20. Se uma das transacoes leu o
    //     before stale e sobrescreveu a linha inteira, um destes dois voltaria ao
    //     valor original (stock==S ou discount==D), e este assert reprova.
    const after = await client.query<{
      stock: number;
      reserved: number;
      price_cents: number;
      discount_pct: number;
      sku: string;
    }>(
      `SELECT stock, reserved, price_cents, discount_pct, sku
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount).toBe(1);
    const p1 = after.rows[0];

    expect(
      p1.stock,
      `lost update: stock final deveria ser S+${STOCK_DELTA}=${S + STOCK_DELTA} (a edicao de discount nao pode sobrescrever o stock com o valor stale ${S})`,
    ).toBe(S + STOCK_DELTA);
    expect(
      p1.discount_pct,
      `lost update: discountPct final deveria ser ${NEW_DISCOUNT} (a edicao de stock nao pode sobrescrever o discount com o valor stale ${D})`,
    ).toBe(NEW_DISCOUNT);

    // --- ASSERT 4 (cents-only): price/discount/stock seguem Int em centavos; nenhum
    //     valor corrompido pela corrida (price base intocado, sem float/NaN).
    expect(p1.price_cents, "priceCents base intocado pela corrida").toBe(BASE_PRICE);
    expect(Number.isInteger(p1.price_cents)).toBe(true);
    expect(Number.isInteger(p1.discount_pct)).toBe(true);
    expect(Number.isInteger(p1.stock)).toBe(true);
    expect(p1.sku, "sku intocado pela corrida").toBe(p0.sku);

    // --- ASSERT 3 (reserved-le-stock): o CHECK existe e nenhuma linha o viola apos a
    //     corrida. reserved permanece R (updateProduct nunca toca reserved) e
    //     S+5 >= R, entao 0<=reserved<=stock segue valido. Reforco DB-cru: o banco
    //     rejeita reserved>stock por SQL direto (oversell impossivel).
    expect(p1.reserved, "reserved permanece R (updateProduct nunca toca reserved)").toBe(R);
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
      // Tenta reserved > stock (S+5): o DB deve rejeitar (oversell impossivel).
      await client.query(`UPDATE "products" SET reserved = $1 WHERE id = $2`, [
        S + STOCK_DELTA + 1,
        productId,
      ]);
    } catch (e) {
      dbRejected = true;
      expect(String((e as Error).message)).toMatch(/products_reserved_le_stock_chk/);
    }
    expect(dbRejected, "DB deve rejeitar reserved > stock (oversell) por SQL cru").toBe(true);

    // --- ASSERT 2 (audit-same-tx): cada update APLICADO gravou exatamente 1 linha
    //     product.update na MESMA transacao. Como ambas as edicoes mudam um campo de
    //     fato (A muda stock, B muda discount), ambas aplicam mutacao => +2 linhas
    //     product.update p/ este produto. Sem audit orfao (nenhuma linha de audit sem
    //     a mutacao correspondente) nem mutacao sem audit (o estado final reflete os 2
    //     updates E ha 2 linhas de audit).
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    expect(
      Number(afterAudit.rows[0].forEntity),
      "este produto deve ganhar exatamente 2 linhas de audit (1 por update aplicado)",
    ).toBe(auditForEntityBefore + 2);
    expect(
      Number(afterAudit.rows[0].total),
      "audit_log total deve ganhar exatamente 2 linhas (sem orfaos)",
    ).toBe(auditTotalBefore + 2);

    // As 2 linhas mais recentes deste produto sao os updates da corrida: action
    // product.update, entity product/this id, before/after snapshots nao-null.
    const logs = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: { stock: number; discountPct: number; priceCents: number } | null;
      after: { stock: number; discountPct: number; priceCents: number } | null;
    }>(
      `SELECT action, entity_type, entity_id, before, after
         FROM "audit_log"
         WHERE entity_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 2`,
      [productId],
    );
    expect(logs.rowCount).toBe(2);
    for (const a of logs.rows) {
      expect(a.action, "action gravado com o @map DOTTED do enum").toBe("product.update");
      expect(a.entity_type).toBe("product");
      expect(a.entity_id).toBe(productId);
      expect(a.before, "update: before deve ser snapshot (nao-null)").toBeTruthy();
      expect(a.after, "update: after deve ser snapshot (nao-null)").toBeTruthy();
      // cents-only no snapshot tambem (priceCents Int, intocado).
      expect(a.after!.priceCents).toBe(BASE_PRICE);
      expect(Number.isInteger(a.after!.priceCents)).toBe(true);
    }

    // A linha de audit MAIS RECENTE (a ultima a commitar) deve refletir o ESTADO FINAL
    // COERENTE da linha: o after da ultima transacao a commitar e o snapshot que ela
    // gravou. Se houve serializacao correta (sem lost update), a transacao que commitou
    // por ultimo enxergou a mutacao da primeira e seu after carrega AMBOS os campos
    // corretos (stock=S+5 E discount=20). Num read-modify-write ingenuo, o after da
    // ultima carregaria o seu proprio campo correto mas o stale do outro — exatamente o
    // lost update que o ASSERT 1 ja pega na linha de products.
    const last = logs.rows[0];
    expect(
      last.after!.stock,
      "after do ultimo update deve refletir o stock final coerente (S+5)",
    ).toBe(S + STOCK_DELTA);
    expect(
      last.after!.discountPct,
      "after do ultimo update deve refletir o discount final coerente (20)",
    ).toBe(NEW_DISCOUNT);
  } finally {
    await client.end();
  }
});

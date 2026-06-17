import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.inactivate-idempotent (priority 20) — DB-first, sem browser.
 *
 * Prova "inativar produto JA INATIVO e no-op (sem audit ruidoso)" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (product-inactivate-audited.spec.ts / product-reactivate-audited.spec.ts): roda
 * em Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: setProductActive(actor, id, false) de lib/data/products.ts — a
 * funcao de menor nivel que prova a invariante. O guard de idempotencia vive em
 * products.ts L352:
 *     if (before.isActive === isActive) return before; // no-op idempotente
 * Como o early-return ocorre ANTES de tx.product.update E de writeAuditLog, uma 2a
 * inativacao do produto JA INATIVO nao escreve nada — nem muda a linha, nem grava
 * audit. NAO chamamos a server action setProductActiveAction porque ela comeca com
 * requireAdmin() (contexto de request: next/headers, Clerk), que quebra fora do
 * HTTP; a action so DELEGA para setProductActive.
 *
 * DADOS PROPRIOS: criamos um produto PROPRIO via createProduct (SKU/nome unicos por
 * run), e o inativamos UMA vez (1a inativacao = 1 audit product.inactivate). So
 * entao medimos A e disparamos a 2a inativacao (a que o ledger testa: no-op). Antes
 * disso FORCAMOS reserved>0 (UPDATE direto na fixture, respeitando o CHECK
 * reserved<=stock) para que os asserts de "estado preservado" NAO virem triviais.
 * Nao tocamos o seed.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as chamadas de seam (createProduct/setProductActive) rodam num
 * processo `tsx` separado (tests/harness/estoque/_run-seam.ts, ja com o case
 * setProductActive), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: audit-same-tx (o no-op nao deixa audit duplicado; a
 * atomicidade do early-return e estrutural na producao).
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamOp = "createProduct" | "setProductActive";

/** Chama uma op do seam via processo tsx e devolve o resultado bruto (JSON). */
function runSeamRaw(
  op: SeamOp,
  payload: unknown,
): { ok?: unknown; err?: { name: string; message: string } } {
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
  if (errLine) return { err: JSON.parse(errLine.slice("__SEAM_ERROR__".length)) };
  if (!okLine) throw new Error(`seam runner sem resultado:\n${out}\n${r.stderr ?? ""}`);
  return { ok: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) };
}

type SeamProduct = { id: string; slug: string; isActive: boolean };

/** Chama uma op que retorna um produto; falha o teste se vier erro de dominio. */
function runProductSeam(op: SeamOp, payload: unknown): SeamProduct {
  const res = runSeamRaw(op, payload);
  if (res.err) throw new Error(`${res.err.name}: ${res.err.message}`);
  return res.ok as SeamProduct;
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const P = 31999; // priceCents base (intocado pelo no-op)
const DISC = 5; // desconto (intocado)
const STOCK = 14; // estoque (intocado)
const RESERVED = 3; // reserved FORCADO > 0 p/ tornar "estado preservado" nao-trivial

test("estoque.product.inactivate-idempotent: 2a inativacao de produto ja inativo e no-op (sem audit novo)", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness InactIdem ${tag}`;
    const sku = `HARNESS-INACTIDEM-${tag}`;
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup: cria um produto PROPRIO (sem tocar o seed), ATIVO, com valores
    //     numericos concretos. createProduct ja grava 1 audit (product.create).
    const created = runProductSeam("createProduct", {
      actor,
      input: {
        name,
        category: "Booster Box",
        sku,
        priceCents: P,
        discountPct: DISC,
        stock: STOCK,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para inactivate-idempotent",
      },
    });
    const productId = created.id;
    expect(created.isActive, "produto nasce ativo").toBe(true);

    // --- setup 2: FORCA reserved>0 (UPDATE direto na fixture). Sem isto os asserts
    //     de "estado preservado" seriam triviais (reserved=0 antes e depois).
    //     Respeita o CHECK products_reserved_le_stock_chk (0 <= RESERVED <= STOCK).
    await client.query(`UPDATE "products" SET reserved = $1 WHERE id = $2`, [RESERVED, productId]);

    // --- setup 3: 1a inativacao (true->false). ESTA grava 1 audit product.inactivate
    //     (coberto pela feature inactivate-audited). O ledger desta feature testa a
    //     2a chamada; por isso medimos A so DEPOIS desta primeira transicao real.
    const first = runProductSeam("setProductActive", { actor, id: productId, isActive: false });
    expect(first.isActive, "1a inativacao leva o produto a inativo").toBe(false);

    // Snapshot pos-1a-inativacao: is_active=false e os campos que NAO podem mudar.
    const pre = await client.query<{
      is_active: boolean;
      price_cents: number;
      discount_pct: number;
      stock: number;
      reserved: number;
      slug: string;
      sku: string;
    }>(
      `SELECT is_active, price_cents, discount_pct, stock, reserved, slug, sku
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    const p0 = pre.rows[0];
    expect(p0.is_active, "produto ja esta INATIVO antes da 2a chamada").toBe(false);
    expect(p0.reserved, "setup forcou reserved>0 (asserts nao-triviais)").toBe(RESERVED);
    expect(p0.price_cents).toBe(P);
    expect(p0.discount_pct).toBe(DISC);
    expect(p0.stock).toBe(STOCK);

    // Contagem-base A: total de produtos (p/ provar que nada e removido/criado) e
    // audit_log (total + por entidade) APOS a 1a inativacao. A 2a chamada (no-op)
    // NAO pode mexer em nenhum desses.
    const baseCounts = await client.query<{
      products: string;
      auditTotal: string;
      auditEntity: string;
      inactivateRows: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM "products")::text AS products,
         (SELECT COUNT(*) FROM "audit_log")::text AS "auditTotal",
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "auditEntity",
         (SELECT COUNT(*) FROM "audit_log"
            WHERE entity_id = $1 AND action = 'product.inactivate')::text AS "inactivateRows"`,
      [productId],
    );
    const productsBase = Number(baseCounts.rows[0].products);
    const A = Number(baseCounts.rows[0].auditTotal); // audit_log total apos a 1a inativacao
    const auditEntityBase = Number(baseCounts.rows[0].auditEntity);
    const inactivateRowsBase = Number(baseCounts.rows[0].inactivateRows);
    // Sanidade do setup: o produto tem create (1) + inactivate (1) = 2 audits, e
    // exatamente 1 product.inactivate ate aqui.
    expect(auditEntityBase, "este produto tem create + 1a inactivate = 2 audits").toBe(2);
    expect(inactivateRowsBase, "exatamente 1 product.inactivate apos a 1a chamada").toBe(1);

    // --- passo 2 (o que o ledger testa): chama setProductActive(actor, id, false)
    //     DE NOVO no produto JA INATIVO. Espera no-op idempotente.
    const result = runProductSeam("setProductActive", { actor, id: productId, isActive: false });
    expect(result.id, "no-op ainda retorna o produto (o before)").toBe(productId);
    expect(result.isActive, "retorno reflete isActive=false (sem mudanca)").toBe(false);

    // --- assert [1]: products.isActive permanece false; linha intacta (nada removido,
    //     nada criado, nenhum campo alterado pelo no-op).
    const after = await client.query<{
      is_active: boolean;
      price_cents: number;
      discount_pct: number;
      stock: number;
      reserved: number;
      slug: string;
      sku: string;
    }>(
      `SELECT is_active, price_cents, discount_pct, stock, reserved, slug, sku
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount, "a linha continua existindo (no-op nao remove)").toBe(1);
    const p1 = after.rows[0];
    expect(p1.is_active, "isActive permanece false").toBe(false);
    expect(p1.price_cents, "priceCents inalterado pelo no-op").toBe(P);
    expect(p1.discount_pct, "discountPct inalterado pelo no-op").toBe(DISC);
    expect(p1.stock, "stock inalterado pelo no-op").toBe(STOCK);
    expect(p1.reserved, "reserved (>0) inalterado pelo no-op").toBe(RESERVED);
    expect(p1.slug, "slug inalterado pelo no-op").toBe(p0.slug);
    expect(p1.sku, "sku inalterado pelo no-op").toBe(p0.sku);

    const productsAfter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"`,
    );
    expect(
      Number(productsAfter.rows[0].count),
      "no-op NAO cria nem remove linha: contagem de produtos inalterada",
    ).toBe(productsBase);

    // --- assert [2]: audit_log NAO ganha linha (count == A): no-op idempotente, sem
    //     audit duplicado. Provado total E por-entidade E por (entidade,action).
    const afterAudit = await client.query<{ total: string; entity: string; inactivate: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS entity,
         (SELECT COUNT(*) FROM "audit_log"
            WHERE entity_id = $1 AND action = 'product.inactivate')::text AS inactivate`,
      [productId],
    );
    expect(Number(afterAudit.rows[0].total), "audit_log total inalterado (count == A)").toBe(A);
    expect(
      Number(afterAudit.rows[0].entity),
      "audit deste produto inalterado (no-op nao gravou nada)",
    ).toBe(auditEntityBase);
    expect(
      Number(afterAudit.rows[0].inactivate),
      "continua existindo EXATAMENTE 1 product.inactivate (sem duplicar)",
    ).toBe(inactivateRowsBase);

    // --- reforco audit-same-tx: o CHECK reserved<=stock segue valido e nenhuma linha
    //     viola 0<=reserved<=stock (o no-op nao corrompeu o invariante de estoque).
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

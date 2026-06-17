import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.reduce-below-reserved-blocks (priority 6) — DB-first, sem browser.
 *
 * Prova "reduzir estoque ABAIXO de reserved e BLOQUEADO" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (product-reduce-stock-above-reserved.spec.ts): roda em Node (sem `page`) e
 * assertaa o estado real via `pg`.
 *
 * SEAM escolhida: updateProduct(actor, id, input) de lib/data/products.ts — a
 * funcao de menor nivel que prova as invariantes. O guard de producao vive em
 * products.ts L289-293, DENTRO de prisma.$transaction porem ANTES de
 * tx.product.update e de writeAuditLog:
 *     if (data.stock < current.reserved) throw new ProductValidationError(...)
 * onde a mensagem CITA as unidades reservadas. Como o throw acontece antes de
 * qualquer escrita, a transacao inteira aborta -> nem o produto muda nem nasce
 * audit (rollback atomico). NAO chamamos a server action updateProductAction:
 * ela comeca com requireAdmin() (contexto de request: next/headers, Clerk), que
 * quebra fora do HTTP; a action so DELEGA para updateProduct.
 *
 * DADOS PROPRIOS (anti-trivialidade): o ledger pede reserved=3, stock=10 e
 * tentar stock=2 (abaixo das 3 reservadas). reserved e gerido pelo ciclo de
 * reserva (nunca por updateProduct), entao o teste:
 *   1. cria seu PROPRIO produto via createProduct (SKU/nome unicos por run) — sem
 *      tocar o seed;
 *   2. FORCA reserved=3 e stock=10 via UPDATE direto em `pg` (forma honesta de
 *      obter reserved>0 neste seam isolado; 3<=10 respeita o CHECK);
 *   3. chama updateProduct com stock=2 (< 3 reservadas) reconstruindo o input
 *      IDENTICO (so o stock muda) -> espera ProductValidationError citando as
 *      unidades reservadas.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as MUTACOES (createProduct/updateProduct) rodam num processo
 * `tsx` separado (tests/harness/estoque/_run-seam.ts, ja suporta ambos), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`. O _run-seam captura o
 * ProductValidationError e o emite como linha `__SEAM_ERROR__{name,message}`, que
 * runSeam re-lanca como Error preservando name/message.
 *
 * Invariantes cobertas: reserved-le-stock, audit-same-tx.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };

/** Chama uma op do seam (createProduct|updateProduct) via processo tsx. */
function runSeam(op: "createProduct" | "updateProduct", payload: unknown): SeamProduct {
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
    const err = new Error(e.message);
    err.name = e.name;
    throw err;
  }
  if (!okLine) throw new Error(`seam runner sem resultado:\n${out}\n${r.stderr ?? ""}`);
  return JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as SeamProduct;
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

type ProductRow = {
  id: string;
  slug: string;
  name: string;
  category: string;
  sku: string;
  price_cents: number;
  discount_pct: number;
  stock: number;
  reserved: number;
  is_active: boolean;
  badge: string | null;
  image_url: string;
  description: string;
};

const R = 3; // unidades reservadas (forcado > 0; o stock alvo fica abaixo disso)
const STOCK_BEFORE = 10; // estoque corrente
const STOCK_TARGET = 2; // tentativa ILEGAL: 2 < 3 reservadas -> deve BLOQUEAR

test("estoque.product.reduce-below-reserved-blocks: reduzir stock para 2 < reserved=3 bloqueia, nada gravado", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness BelowReserved ${tag}`;
    const sku = `HARNESS-BELOWRES-${tag}`;
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup: cria um produto PROPRIO (sem tocar o seed). Stock inicial alto e
    //     irrelevante; vamos forcar stock/reserved direto no DB a seguir.
    const created = runSeam("createProduct", {
      actor,
      input: {
        name,
        category: "Booster Box",
        sku,
        priceCents: 19990,
        discountPct: 10,
        stock: 50,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para reduce-below-reserved-blocks",
      },
    });
    const productId = created.id;

    // --- passo 1: define reserved=R(3) e stock=STOCK_BEFORE(10). reserved e gerido
    //     pelo ciclo de reserva (nunca por updateProduct), entao o UPDATE direto e a
    //     forma honesta de obter reserved>0. (3<=10 respeita o CHECK reserved<=stock.)
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK_BEFORE,
      R,
      productId,
    ]);

    // Le a linha COMPLETA pos-setup p/ reconstruir o input IDENTICO (so o stock muda).
    const pre = await client.query<ProductRow>(
      `SELECT id, slug, name, category, sku, price_cents, discount_pct, stock, reserved,
              is_active, badge, image_url, description
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    const p0 = pre.rows[0];
    expect(p0.stock, "setup deve deixar stock=STOCK_BEFORE").toBe(STOCK_BEFORE);
    expect(p0.reserved, "setup deve deixar reserved=R (>0)").toBe(R);
    expect(R).toBeGreaterThan(0);
    // Sanidade: o alvo da reducao e mesmo ABAIXO das unidades reservadas.
    expect(STOCK_TARGET).toBeLessThan(R);

    // Conta audit_log inicial deste produto e o total, p/ provar que NADA e gravado
    // pela tentativa bloqueada. O createProduct ja deixou 1 audit (product.create).
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    expect(auditForEntityBefore, "createProduct ja deixou 1 audit deste produto").toBe(1);

    // --- passo 2: chama updateProduct com o MESMO input, porem stock = STOCK_TARGET (2 < 3).
    const input = {
      name: p0.name,
      category: p0.category,
      sku: p0.sku,
      priceCents: p0.price_cents,
      discountPct: p0.discount_pct,
      stock: STOCK_TARGET,
      badge: p0.badge,
      imageUrl: p0.image_url,
      description: p0.description,
    };

    // --- assert: updateProduct LANCA ProductValidationError citando as unidades reservadas.
    let thrown: Error | null = null;
    try {
      runSeam("updateProduct", { actor, id: productId, input });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown, "reduzir abaixo de reserved deve lancar erro").toBeTruthy();
    expect(thrown!.name, "deve ser ProductValidationError").toBe("ProductValidationError");
    // A mensagem deve citar tanto o estoque tentado (2) quanto as reservadas (3) e
    // mencionar 'reservada(s)' (products.ts L290-292) — nao um throw generico.
    expect(thrown!.message, "mensagem deve citar unidades reservadas").toMatch(/reservada/i);
    expect(thrown!.message, "mensagem deve citar a contagem de reservadas").toContain(String(R));
    expect(thrown!.message, "mensagem deve citar o estoque tentado").toContain(
      String(STOCK_TARGET),
    );

    // --- assert: products.stock permanece 10; products.reserved permanece 3 (nada gravado).
    const after = await client.query<{
      stock: number;
      reserved: number;
      price_cents: number;
      discount_pct: number;
      slug: string;
      sku: string;
      name: string;
    }>(
      `SELECT stock, reserved, price_cents, discount_pct, slug, sku, name
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount).toBe(1);
    const p1 = after.rows[0];

    expect(p1.stock, "stock NAO pode mudar (rollback)").toBe(STOCK_BEFORE);
    expect(Number.isInteger(p1.stock)).toBe(true);
    expect(p1.reserved, "reserved NAO pode mudar (rollback)").toBe(R);
    // A linha inteira deve estar exatamente como antes da tentativa (nada parcial).
    expect(p1.price_cents).toBe(p0.price_cents);
    expect(p1.discount_pct).toBe(p0.discount_pct);
    expect(p1.sku).toBe(p0.sku);
    expect(p1.slug).toBe(p0.slug);
    expect(p1.name).toBe(p0.name);

    // --- assert: audit_log NAO ganha linha (rollback da transacao inteira).
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    expect(Number(afterAudit.rows[0].total), "audit_log total NAO pode crescer (rollback)").toBe(
      auditTotalBefore,
    );
    expect(
      Number(afterAudit.rows[0].forEntity),
      "este produto NAO pode ganhar audit (rollback)",
    ).toBe(auditForEntityBefore);
    // Reforco: zero linhas product.update para este produto (a unica audit e o create).
    const updates = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE entity_id = $1 AND action = 'product.update'`,
      [productId],
    );
    expect(Number(updates.rows[0].count), "nenhum product.update orfao do bloqueio").toBe(0);

    // --- assert: CHECK 0<=reserved<=stock segue como rede final (jamais 3>2).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    // Reforco direto na linha alvo: reserved(3) <= stock(10), nunca 3>2 (o bloqueio
    // impediu o estado proibido de ser persistido).
    expect(p1.reserved <= p1.stock, "reserved deve permanecer <= stock (3 <= 10)").toBe(true);
  } finally {
    await client.end();
  }
});

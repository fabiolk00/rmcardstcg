import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.reduce-stock-above-reserved (priority 5) — DB-first, sem browser.
 *
 * Prova "admin reduz o estoque mantendo stock >= reserved" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (product-increase-stock.spec.ts): roda em Node (sem `page`) e assertaa o
 * estado real via `pg`.
 *
 * SEAM escolhida: updateProduct(actor, id, input) de lib/data/products.ts — a
 * funcao de menor nivel que prova as invariantes (prisma.$transaction + le o
 * before, aplica o guard data.stock < current.reserved, e writeAuditLog na MESMA
 * tx, before/after). NAO chamamos a server action updateProductAction porque ela
 * comeca com requireAdmin() (contexto de request: next/headers, Clerk), que
 * quebra fora do HTTP; a action so DELEGA para updateProduct.
 *
 * DADOS PROPRIOS (anti-trivialidade): o ledger pede "Define um produto com
 * reserved=R>0". O guard de producao e `data.stock < current.reserved` (products.ts
 * L289): com reserved=0 a reducao seria SEMPRE permitida e o assert "reserved
 * inalterado" cairia em 0==0 trivial. Por isso o teste:
 *   1. cria seu PROPRIO produto via createProduct (SKU/nome unicos por run, stock
 *      inicial alto) — sem mexer no seed;
 *   2. FORCA reserved=R(2) e stock=10 via UPDATE direto em `pg` (a coluna reserved
 *      e gerida pelo ciclo de reserva, nunca por updateProduct — entao o seed
 *      direto e a unica forma honesta de obter reserved>0 neste seam isolado);
 *   3. chama updateProduct com stock=5 (ainda >= 2) reconstruindo o input IDENTICO
 *      (so o stock muda), p/ que o snapshot before/after do audit reflita SO o
 *      delta de stock (reserved nem e campo do input).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as MUTACOES (createProduct/updateProduct) rodam num processo
 * `tsx` separado (tests/harness/estoque/_run-seam.ts, ja suporta ambos), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
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
    throw new Error(`${e.name}: ${e.message}`);
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

const R = 2; // unidades reservadas (forcado > 0 p/ tornar o assert nao-trivial)
const STOCK_BEFORE = 10; // estoque antes da reducao
const STOCK_AFTER = 5; // novo estoque (ainda >= R, reducao acima de reserved)

test("estoque.product.reduce-stock-above-reserved: stock=5 mantendo reserved=2, audita na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Reduce ${tag}`;
    const sku = `HARNESS-REDUCE-${tag}`;
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
        description: "fixture do harness para reduce-stock-above-reserved",
      },
    });
    const productId = created.id;

    // --- passo 1: define reserved=R(>0) e stock=STOCK_BEFORE. reserved e gerido pelo
    //     ciclo de reserva (nunca por updateProduct), entao o UPDATE direto e a forma
    //     honesta de obter reserved>0 p/ este seam isolado. (R<=stock respeita o CHECK.)
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
    expect(p0.reserved, "setup deve deixar reserved=R (>0, nao trivial)").toBe(R);
    expect(R).toBeGreaterThan(0);

    // Conta audit_log inicial deste produto e o total, p/ provar "exatamente 1 linha nova".
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    // O createProduct ja gravou 1 audit (product.create); a reducao deve somar +1.
    expect(auditForEntityBefore, "createProduct ja deixou 1 audit deste produto").toBe(1);

    // --- passo 2: chama updateProduct com o MESMO input, porem stock = STOCK_AFTER (5 >= 2).
    const input = {
      name: p0.name,
      category: p0.category,
      sku: p0.sku,
      priceCents: p0.price_cents,
      discountPct: p0.discount_pct,
      stock: STOCK_AFTER,
      badge: p0.badge,
      imageUrl: p0.image_url,
      description: p0.description,
    };

    const updated = runSeam("updateProduct", { actor, id: productId, input });
    expect(updated.id, "updateProduct deve retornar o produto").toBe(productId);

    // --- assert: products.stock == 5; products.reserved == R (inalterado).
    const after = await client.query<{
      stock: number;
      reserved: number;
      price_cents: number;
      discount_pct: number;
      slug: string;
      sku: string;
    }>(
      `SELECT stock, reserved, price_cents, discount_pct, slug, sku
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount).toBe(1);
    const p1 = after.rows[0];

    expect(p1.stock, "stock deve cair para STOCK_AFTER").toBe(STOCK_AFTER);
    expect(Number.isInteger(p1.stock)).toBe(true);
    expect(p1.reserved, "reserved nao pode mudar numa reducao de estoque").toBe(R);
    // Sanidade da reducao real: novo stock < stock anterior, mas ainda >= reserved.
    expect(p1.stock).toBeLessThan(STOCK_BEFORE);
    expect(p1.stock).toBeGreaterThanOrEqual(p1.reserved);

    // Nada mais do produto deve ter mudado (input identico exceto stock).
    expect(p1.price_cents).toBe(p0.price_cents);
    expect(Number.isInteger(p1.price_cents)).toBe(true);
    expect(p1.discount_pct).toBe(p0.discount_pct);
    expect(p1.sku).toBe(p0.sku);
    expect(p1.slug, "mesmo nome -> mesmo slug (uniqueSlug exclui o proprio id)").toBe(p0.slug);

    // disponivel = stock - reserved (derivado, nao persistido) == 3.
    expect(p1.stock - p1.reserved, "disponivel = stock - reserved").toBe(STOCK_AFTER - R);

    // --- assert: CHECK 0<=reserved<=stock continua valido (existe + 0 violacoes).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    // Reforco direto na linha alvo: 5 >= 2 (reducao acima de reserved nunca viola).
    expect(p1.reserved <= p1.stock, "reserved deve permanecer <= novo stock (5 >= 2)").toBe(true);

    // --- assert: audit_log recebe EXATAMENTE 1 linha nova, action=product.update,
    //     na MESMA transacao, before.stock=STOCK_BEFORE e after.stock=STOCK_AFTER.
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    expect(Number(afterAudit.rows[0].total), "audit_log total deve ganhar 1 linha").toBe(
      auditTotalBefore + 1,
    );
    expect(Number(afterAudit.rows[0].forEntity), "este produto deve ganhar 1 linha de audit").toBe(
      auditForEntityBefore + 1,
    );

    // Pega a linha de audit mais recente deste produto (a do update que acabamos de fazer).
    const log = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: { stock: number; reserved?: number; priceCents: number; discountPct: number } | null;
      after: { stock: number; reserved?: number; priceCents: number; discountPct: number } | null;
    }>(
      `SELECT action, entity_type, entity_id, before, after
         FROM "audit_log"
         WHERE entity_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      [productId],
    );
    expect(log.rowCount).toBe(1);
    const a = log.rows[0];

    // action gravado com o valor DOTTED do enum (schema.prisma usa @map("product.update")).
    expect(a.action).toBe("product.update");
    expect(a.entity_type).toBe("product");
    expect(a.entity_id).toBe(productId);

    // before/after sao snapshots do dominio (camelCase). before.stock=10, after.stock=5.
    expect(a.before, "update: before deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.after, "update: after deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.before!.stock, "before.stock deve refletir o STOCK_BEFORE").toBe(STOCK_BEFORE);
    expect(a.after!.stock, "after.stock deve refletir STOCK_AFTER").toBe(STOCK_AFTER);

    // delta limpo: SO o stock mudou no snapshot (centavos/desconto intactos no audit).
    expect(a.before!.priceCents).toBe(p0.price_cents);
    expect(a.after!.priceCents).toBe(p0.price_cents);
    expect(a.before!.discountPct).toBe(p0.discount_pct);
    expect(a.after!.discountPct).toBe(p0.discount_pct);
    // reserved nao e campo do snapshot de produto (auditSnapshot nao inclui reserved):
    // o audit do update NAO carrega reserved, reforcando que a reducao nao o tocou.
    expect(a.before!.reserved, "snapshot de produto nao inclui reserved").toBeUndefined();
    expect(a.after!.reserved, "snapshot de produto nao inclui reserved").toBeUndefined();
  } finally {
    await client.end();
  }
});

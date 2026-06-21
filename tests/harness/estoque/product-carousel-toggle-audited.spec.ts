import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.carousel-toggle-audited — DB-first, sem browser.
 *
 * Prova "admin marca/desmarca o produto no carrossel da landing com auditoria"
 * contra o Postgres efemero REAL (process.env.DATABASE_URL, exposto pelo runner
 * scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (product-inactivate-audited.spec.ts): roda em Node (sem `page`) e assertaa o
 * estado real via `pg`.
 *
 * SEAM: updateProduct(actor, id, input) de lib/data/products.ts — o MESMO fluxo
 * que a server action updateProductAction delega apos requireAdmin(). updateProduct
 * roda prisma.$transaction { le baseline; monta o DIFF DE INTENCAO (so colunas que
 * mudaram entram no UPDATE — evita lost-update sob edicao concorrente); UPDATE +
 * writeAuditLog (action product.update, before/after) na MESMA tx }.
 *
 * NOTA sobre no-op: updateProduct NAO tem early-return de no-op (so setProductActive
 * tem). Cada chamada grava 1 audit product.update. O diff de intencao controla QUAIS
 * colunas sao escritas, nao SE ha audit. Por isso aqui provamos persistencia + audit
 * + DELTA LIMPO (so isCarousel muda entre before/after), nas duas direcoes.
 *
 * CAVEAT do harness (resolvido como infra): o client Prisma e ESM puro; o runner do
 * Playwright transpila os specs p/ CJS (import.meta = SyntaxError). Por isso a seam
 * roda num processo `tsx` (tests/harness/estoque/_run-seam.ts, que ja tem o case
 * updateProduct) e o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: audit-same-tx.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamOp = "createProduct" | "updateProduct";

function runSeamRaw(
  op: SeamOp,
  payload: unknown,
): { ok?: unknown; err?: { name: string; message: string } } {
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
  if (errLine) return { err: JSON.parse(errLine.slice("__SEAM_ERROR__".length)) };
  if (!okLine) throw new Error(`seam runner sem resultado:\n${out}\n${r.stderr ?? ""}`);
  return { ok: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) };
}

type SeamProduct = { id: string; slug: string; isCarousel: boolean };

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

const P = 31900; // priceCents base (intocado pelo toggle)
const DISC = 12; // desconto (intocado)
const STOCK = 15; // estoque (intocado)

type AuditRow = {
  action: string;
  entity_type: string;
  entity_id: string;
  before: { isCarousel: boolean; priceCents: number; stock: number } | null;
  after: { isCarousel: boolean; priceCents: number; stock: number } | null;
};

async function latestAudit(client: Client, productId: string): Promise<AuditRow> {
  const log = await client.query<AuditRow>(
    `SELECT action, entity_type, entity_id, before, after
       FROM "audit_log" WHERE entity_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    [productId],
  );
  expect(log.rowCount).toBe(1);
  return log.rows[0];
}

async function countEntityAudit(client: Client, productId: string): Promise<number> {
  const r = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE entity_id = $1`,
    [productId],
  );
  return Number(r.rows[0].count);
}

test("estoque.product.carousel-toggle-audited: isCarousel false<->true persiste e audita na mesma tx (delta limpo)", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const sku = `HARNESS-CAROUSEL-${tag}`;
    const actor = { clerkUserId: null, email: null, role: null };
    // Input completo reusado entre create/update: so isCarousel muda entre as chamadas,
    // entao o diff de intencao do updateProduct deixa o UPDATE com SO a coluna is_carousel.
    const baseInput = {
      name: `Produto Harness Carousel ${tag}`,
      category: "Booster Box",
      sku,
      priceCents: P,
      discountPct: DISC,
      stock: STOCK,
      badge: null,
      imageUrl: "/products/placeholder.svg",
      description: "fixture do harness para carousel-toggle-audited",
    };

    // --- setup: cria o produto com isCarousel:false (createProduct ja grava 1 audit).
    const created = runProductSeam("createProduct", {
      actor,
      input: { ...baseInput, isCarousel: false },
    });
    const productId = created.id;
    expect(created.isCarousel, "produto nasce fora do carrossel").toBe(false);

    const seeded = await client.query<{ is_carousel: boolean }>(
      `SELECT is_carousel FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(seeded.rowCount).toBe(1);
    expect(seeded.rows[0].is_carousel, "create persistiu is_carousel=false").toBe(false);
    expect(await countEntityAudit(client, productId), "create deixou 1 audit").toBe(1);

    // === passo 1: MARCA (false -> true) ===
    const on = runProductSeam("updateProduct", {
      actor,
      id: productId,
      input: { ...baseInput, isCarousel: true },
    });
    expect(on.isCarousel, "retorno reflete isCarousel=true").toBe(true);

    const afterOn = await client.query<{
      is_carousel: boolean;
      price_cents: number;
      stock: number;
    }>(`SELECT is_carousel, price_cents, stock FROM "products" WHERE id = $1`, [productId]);
    expect(afterOn.rows[0].is_carousel, "is_carousel persiste true").toBe(true);
    expect(afterOn.rows[0].price_cents, "preco intocado pelo toggle").toBe(P);
    expect(afterOn.rows[0].stock, "estoque intocado pelo toggle").toBe(STOCK);

    expect(await countEntityAudit(client, productId), "marcar gera +1 audit").toBe(2);
    const a1 = await latestAudit(client, productId);
    expect(a1.action, "action @map dotted product.update").toBe("product.update");
    expect(a1.entity_type).toBe("product");
    expect(a1.before?.isCarousel, "before.isCarousel=false").toBe(false);
    expect(a1.after?.isCarousel, "after.isCarousel=true").toBe(true);
    // Delta limpo: so o flag muda; preco/estoque iguais nos dois snapshots.
    expect(a1.before?.priceCents).toBe(P);
    expect(a1.after?.priceCents).toBe(P);
    expect(a1.before?.stock).toBe(STOCK);
    expect(a1.after?.stock).toBe(STOCK);

    // === passo 2: DESMARCA (true -> false) ===
    const off = runProductSeam("updateProduct", {
      actor,
      id: productId,
      input: { ...baseInput, isCarousel: false },
    });
    expect(off.isCarousel, "retorno reflete isCarousel=false").toBe(false);

    const afterOff = await client.query<{ is_carousel: boolean }>(
      `SELECT is_carousel FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(afterOff.rows[0].is_carousel, "is_carousel volta a false").toBe(false);

    expect(await countEntityAudit(client, productId), "desmarcar gera +1 audit (total 3)").toBe(3);
    const a2 = await latestAudit(client, productId);
    expect(a2.action).toBe("product.update");
    expect(a2.before?.isCarousel, "before.isCarousel=true").toBe(true);
    expect(a2.after?.isCarousel, "after.isCarousel=false").toBe(false);
  } finally {
    await client.end();
  }
});

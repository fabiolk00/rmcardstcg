import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.price.update-discount-audited (priority 17) — DB-first, sem browser.
 *
 * Prova "admin altera o desconto do produto (auditado, derivacao recalcula)" contra
 * o Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (product-reduce-stock-above-reserved.spec.ts / product-increase-stock.spec.ts):
 * roda em Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: updateProduct(actor, id, input) de lib/data/products.ts — a
 * funcao de menor nivel que prova as invariantes (prisma.$transaction + le o
 * before, valida discountPct na faixa 0..80 via normalizeProductInput, e
 * writeAuditLog na MESMA tx, before/after). NAO chamamos a server action
 * updateProductAction porque ela comeca com requireAdmin() (contexto de request:
 * next/headers, Clerk), que quebra fora do HTTP; a action so DELEGA para updateProduct.
 *
 * Para o preco final derivado, usamos a SEAM PURA finalPriceCents(p) de
 * lib/data/pricing.ts (case 'finalPriceCents' do runner): chama a FUNCAO REAL de
 * producao sem tocar o banco, provando que o preco final e derivado por funcao pura
 * (nunca persistido) e bate com a derivacao SQL sobre o produto realmente gravado.
 *
 * DADOS PROPRIOS: criamos um produto PROPRIO via createProduct (SKU/nome unicos por
 * run) com discountPct=0 e priceCents=P, sem tocar o seed. Depois chamamos
 * updateProduct com discountPct=20 mantendo priceCents=P e o resto IDENTICO, para
 * que o snapshot before/after do audit reflita SO o delta de desconto.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as chamadas de seam (createProduct/updateProduct/finalPriceCents)
 * rodam num processo `tsx` separado (tests/harness/estoque/_run-seam.ts, ja suporta
 * os tres), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: final-price-derived, cents-only, audit-same-tx.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamOp = "createProduct" | "updateProduct" | "finalPriceCents";

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

type SeamProduct = { id: string; slug: string };

/** Chama uma op que retorna um produto; falha o teste se vier erro de dominio. */
function runProductSeam(op: "createProduct" | "updateProduct", payload: unknown): SeamProduct {
  const res = runSeamRaw(op, payload);
  if (res.err) throw new Error(`${res.err.name}: ${res.err.message}`);
  return res.ok as SeamProduct;
}

/** Chama a seam pura finalPriceCents (sem banco) e devolve o numero derivado. */
function runFinalPriceCents(priceCents: number, discountPct: number): number {
  const res = runSeamRaw("finalPriceCents", { priceCents, discountPct });
  if (res.err) throw new Error(`${res.err.name}: ${res.err.message}`);
  return res.ok as number;
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

const P = 12345; // priceCents base (intocado durante a alteracao de desconto)
const DISC_BEFORE = 0; // desconto inicial
const DISC_AFTER = 20; // novo desconto (dentro da faixa 0..80)

test("estoque.price.update-discount-audited: discountPct 0->20, base intocada, audita na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Discount ${tag}`;
    const sku = `HARNESS-DISCOUNT-${tag}`;
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup: cria um produto PROPRIO (sem tocar o seed) com discountPct=0 e
    //     priceCents=P. createProduct ja grava 1 audit (product.create).
    const created = runProductSeam("createProduct", {
      actor,
      input: {
        name,
        category: "Booster Box",
        sku,
        priceCents: P,
        discountPct: DISC_BEFORE,
        stock: 30,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para update-discount-audited",
      },
    });
    const productId = created.id;

    // Le a linha COMPLETA pos-create p/ reconstruir o input IDENTICO (so o desconto muda).
    const pre = await client.query<ProductRow>(
      `SELECT id, slug, name, category, sku, price_cents, discount_pct, stock, reserved,
              is_active, badge, image_url, description
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    const p0 = pre.rows[0];
    expect(p0.price_cents, "setup deve gravar priceCents=P").toBe(P);
    expect(p0.discount_pct, "setup deve gravar discountPct=0").toBe(DISC_BEFORE);

    // Conta audit_log inicial (total e por entidade) p/ provar "exatamente 1 linha nova".
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [productId],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);
    expect(auditForEntityBefore, "createProduct ja deixou 1 audit deste produto").toBe(1);

    // --- passo 2: chama updateProduct com o MESMO input, porem discountPct=DISC_AFTER
    //     (mantendo priceCents=P e todo o resto identico).
    const input = {
      name: p0.name,
      category: p0.category,
      sku: p0.sku,
      priceCents: p0.price_cents,
      discountPct: DISC_AFTER,
      stock: p0.stock,
      badge: p0.badge,
      imageUrl: p0.image_url,
      description: p0.description,
    };

    const updated = runProductSeam("updateProduct", { actor, id: productId, input });
    expect(updated.id, "updateProduct deve retornar o produto").toBe(productId);

    // --- assert [1]: products.discountPct == 20; priceCents == P (base intocada).
    const after = await client.query<{
      price_cents: number;
      discount_pct: number;
      stock: number;
      slug: string;
      sku: string;
    }>(`SELECT price_cents, discount_pct, stock, slug, sku FROM "products" WHERE id = $1`, [
      productId,
    ]);
    expect(after.rowCount).toBe(1);
    const p1 = after.rows[0];

    expect(p1.discount_pct, "discountPct deve passar a DISC_AFTER").toBe(DISC_AFTER);
    expect(
      Number.isInteger(p1.discount_pct),
      "discountPct e Int (cents-only/derivacao integra)",
    ).toBe(true);
    expect(p1.price_cents, "priceCents base nao pode mudar ao alterar o desconto").toBe(P);
    expect(Number.isInteger(p1.price_cents), "priceCents e Int (cents-only)").toBe(true);
    // Nada mais mudou: stock/sku/slug identicos (input identico exceto desconto).
    expect(p1.stock).toBe(p0.stock);
    expect(p1.sku).toBe(p0.sku);
    expect(p1.slug, "mesmo nome -> mesmo slug (uniqueSlug exclui o proprio id)").toBe(p0.slug);

    // --- assert [2]: finalPriceCents passa a round(P*0.80) SEM nenhuma coluna persistida.
    // (a) a FUNCAO REAL de producao (seam pura, sem banco) com os valores POS-update.
    const expectedFinal = Math.round(P * (1 - DISC_AFTER / 100)); // round(12345*0.80) = 9876
    const finalAfter = runFinalPriceCents(p1.price_cents, p1.discount_pct);
    expect(finalAfter, "finalPriceCents(P,20) == round(P*0.80)").toBe(expectedFinal);
    expect(Number.isInteger(finalAfter), "finalPriceCents e Int de centavos").toBe(true);
    // Sanidade: antes do update (desconto 0) o preco final era a propria base.
    expect(runFinalPriceCents(P, DISC_BEFORE), "finalPriceCents(P,0) == P").toBe(P);
    // (b) paridade com a derivacao SQL sobre o produto REALMENTE gravado.
    const sqlFinal = await client.query<{ final: string }>(
      `SELECT ROUND(price_cents * (1 - discount_pct::numeric / 100))::int::text AS final
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(Number(sqlFinal.rows[0].final), "derivacao SQL bate com a funcao pura").toBe(
      expectedFinal,
    );

    // (c) NENHUMA coluna de preco final persistida (so price_cents/discount_pct).
    const cols = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'products'`,
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names, "products deve ter price_cents").toContain("price_cents");
    expect(names, "products deve ter discount_pct").toContain("discount_pct");
    const finalLike = names.filter((n) => /final.?price|preco.?final|price.?final/i.test(n));
    expect(finalLike, "NAO deve existir coluna de preco final persistida").toEqual([]);
    // price_cents/discount_pct sao integer (cents-only / derivacao integra).
    const typeOf = (n: string) => cols.rows.find((c) => c.column_name === n)?.data_type;
    expect(typeOf("price_cents"), "price_cents e integer").toBe("integer");
    expect(typeOf("discount_pct"), "discount_pct e integer").toBe("integer");

    // --- assert [3]: audit_log recebe EXATAMENTE 1 linha nova, action=product.update,
    //     na MESMA transacao, before.discountPct=0 e after.discountPct=20.
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

    const log = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: { discountPct: number; priceCents: number; stock: number } | null;
      after: { discountPct: number; priceCents: number; stock: number } | null;
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

    expect(a.before, "update: before deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.after, "update: after deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.before!.discountPct, "before.discountPct deve refletir DISC_BEFORE").toBe(DISC_BEFORE);
    expect(a.after!.discountPct, "after.discountPct deve refletir DISC_AFTER").toBe(DISC_AFTER);
    // delta limpo: a base (priceCents) e o stock nao mudaram nos snapshots.
    expect(a.before!.priceCents).toBe(P);
    expect(a.after!.priceCents).toBe(P);
    expect(a.before!.stock).toBe(p0.stock);
    expect(a.after!.stock).toBe(p0.stock);

    // --- assert [4]: discountPct rejeita >80 (faixa 0..80). Reconstrucao do MESMO
    //     input porem com discountPct=81 deve lancar ProductValidationError e NAO
    //     gravar nada (transacao nem abre: validacao roda ANTES de prisma.$transaction).
    const invalidInput = { ...input, discountPct: 81 };
    const rejected = runSeamRaw("updateProduct", { actor, id: productId, input: invalidInput });
    expect(rejected.err, "discountPct=81 deve ser rejeitado por erro de dominio").toBeTruthy();
    expect(rejected.err!.name, "deve ser ProductValidationError").toBe("ProductValidationError");
    expect(rejected.err!.message, "mensagem deve citar a faixa de desconto").toMatch(/[Dd]esconto/);
    // Reforco da fronteira: 80 e ACEITO (limite superior valido) — provamos via funcao
    // pura (faixa 0..80 inclusiva), sem mutar o produto.
    expect(runFinalPriceCents(P, 80), "discountPct=80 e valido (limite superior)").toBe(
      Math.round(P * 0.2),
    );

    // Estado intacto apos a rejeicao: discountPct continua DISC_AFTER, nenhuma linha nova.
    const afterReject = await client.query<{ discount_pct: number; price_cents: number }>(
      `SELECT discount_pct, price_cents FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(afterReject.rows[0].discount_pct, "rejeicao nao altera o desconto persistido").toBe(
      DISC_AFTER,
    );
    expect(afterReject.rows[0].price_cents, "rejeicao nao altera a base").toBe(P);
    const finalAudit = await client.query<{ forEntity: string }>(
      `SELECT COUNT(*)::text AS "forEntity" FROM "audit_log" WHERE entity_id = $1`,
      [productId],
    );
    expect(
      Number(finalAudit.rows[0].forEntity),
      "rejeicao por validacao NAO grava audit (rollback antes da tx)",
    ).toBe(auditForEntityBefore + 1);
  } finally {
    await client.end();
  }
});

import { spawnSync } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.increase-stock (priority 4) — DB-first, sem browser.
 *
 * Prova a operacao manual "admin aumenta o estoque de um produto" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO de product-create.spec.ts:
 * roda em Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: updateProduct(actor, id, input) de lib/data/products.ts — a
 * funcao de menor nivel que prova as invariantes (transacao Prisma + writeAuditLog
 * na MESMA tx, before/after). NAO chamamos a server action updateProductAction
 * porque ela comeca com requireAdmin() (contexto de request: next/headers, Clerk),
 * que quebra fora do HTTP; a action so DELEGA para updateProduct.
 *
 * IMPORTANTE (delta limpo): updateProduct recebe um ProductInput COMPLETO (name,
 * category, sku, priceCents, discountPct, stock, badge, imageUrl, description) e
 * sobrescreve todos esses campos. Para que a mutacao seja "so o estoque mudou",
 * o teste primeiro LE a linha atual via `pg` e reconstroi o input IDENTICO, mudando
 * APENAS stock para S+10. Assim o snapshot before/after do audit_log reflete o
 * delta de stock e nada mais (reserved nem sequer e campo do input — e gerido pelo
 * ciclo de reserva, nunca por updateProduct).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso a MUTACAO roda num processo `tsx` separado
 * (tests/harness/estoque/_run-seam.ts, ESTENDIDO nesta sessao p/ suportar
 * updateProduct), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: reserved-le-stock, audit-same-tx.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };

/** Chama updateProduct via processo tsx; retorna o produto atualizado (ou lanca). */
function runUpdateProduct(payload: unknown): SeamProduct {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, "updateProduct"], {
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

test("estoque.product.increase-stock: stock=S+10, reserved inalterado, audita na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- passo 1: le stock S e reserved R de um produto do seed (o mais antigo por
    //     created_at, para escolha deterministica). Le a linha COMPLETA p/ reconstruir
    //     o input identico (so o stock muda).
    const target = await client.query<ProductRow>(
      `SELECT id, slug, name, category, sku, price_cents, discount_pct, stock, reserved,
              is_active, badge, image_url, description
         FROM "products"
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
    );
    expect(target.rowCount, "o seed deve ter ao menos 1 produto").toBe(1);
    const p0 = target.rows[0];
    const S = p0.stock;
    const R = p0.reserved;
    expect(Number.isInteger(S)).toBe(true);
    expect(Number.isInteger(R)).toBe(true);

    // Conta audit_log inicial deste produto e o total, p/ provar "exatamente 1 linha nova".
    const beforeAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [p0.id],
    );
    const auditTotalBefore = Number(beforeAudit.rows[0].total);
    const auditForEntityBefore = Number(beforeAudit.rows[0].forEntity);

    // --- passo 2: chama updateProduct com o MESMO input, porem stock = S+10.
    const input = {
      name: p0.name,
      category: p0.category,
      sku: p0.sku,
      priceCents: p0.price_cents,
      discountPct: p0.discount_pct,
      stock: S + 10,
      badge: p0.badge,
      imageUrl: p0.image_url,
      description: p0.description,
    };
    const actor = { clerkUserId: null, email: null, role: null };

    const updated = runUpdateProduct({ actor, id: p0.id, input });
    expect(updated.id, "updateProduct deve retornar o produto").toBe(p0.id);

    // --- assert: products.stock == S+10; products.reserved == R (inalterado).
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
      [p0.id],
    );
    expect(after.rowCount).toBe(1);
    const p1 = after.rows[0];

    expect(p1.stock, "stock deve subir exatamente +10").toBe(S + 10);
    expect(Number.isInteger(p1.stock)).toBe(true);
    expect(p1.reserved, "reserved nao pode mudar num aumento de estoque").toBe(R);

    // Nada mais do produto deve ter mudado (input identico exceto stock): centavos,
    // desconto, sku e slug intactos. (cents-only de tabela: continuam Int.)
    expect(p1.price_cents).toBe(p0.price_cents);
    expect(Number.isInteger(p1.price_cents)).toBe(true);
    expect(p1.discount_pct).toBe(p0.discount_pct);
    expect(p1.sku).toBe(p0.sku);
    expect(p1.slug, "mesmo nome -> mesmo slug (uniqueSlug exclui o proprio id)").toBe(p0.slug);

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
    // Reforco direto na linha alvo: R <= S+10 (aumentar estoque nunca pode violar).
    expect(R <= S + 10, "reserved deve permanecer <= novo stock").toBe(true);

    // --- assert: audit_log recebe EXATAMENTE 1 linha nova, action=product.update,
    //     na MESMA transacao, before.stock=S e after.stock=S+10.
    const afterAudit = await client.query<{ total: string; forEntity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "forEntity"`,
      [p0.id],
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
      before: { stock: number; priceCents: number; discountPct: number } | null;
      after: { stock: number; priceCents: number; discountPct: number } | null;
    }>(
      `SELECT action, entity_type, entity_id, before, after
         FROM "audit_log"
         WHERE entity_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      [p0.id],
    );
    expect(log.rowCount).toBe(1);
    const a = log.rows[0];

    // action gravado com o valor DOTTED do enum (schema.prisma usa @map("product.update")).
    expect(a.action).toBe("product.update");
    expect(a.entity_type).toBe("product");
    expect(a.entity_id).toBe(p0.id);

    // before/after sao snapshots do dominio (camelCase). before.stock=S, after.stock=S+10.
    expect(a.before, "update: before deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.after, "update: after deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.before!.stock, "before.stock deve refletir o S anterior").toBe(S);
    expect(a.after!.stock, "after.stock deve refletir S+10").toBe(S + 10);

    // delta limpo: SO o stock mudou no snapshot (centavos/desconto intactos no audit).
    expect(a.before!.priceCents).toBe(p0.price_cents);
    expect(a.after!.priceCents).toBe(p0.price_cents);
    expect(a.before!.discountPct).toBe(p0.discount_pct);
    expect(a.after!.discountPct).toBe(p0.discount_pct);
  } finally {
    await client.end();
  }
});

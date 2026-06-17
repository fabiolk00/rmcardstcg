import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.create (priority 1) — DB-first, sem browser.
 *
 * Prova a operacao manual "admin cria produto novo (CRUD create + auditoria)"
 * contra o Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO do 1o teste de
 * smoke.admin.spec.ts: roda em Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: createProduct(actor, input) de lib/data/products.ts — a funcao
 * de MENOR NIVEL que ainda prova as invariantes (transacao Prisma + writeAuditLog
 * na MESMA tx). NAO chamamos a server action createProductAction porque ela comeca
 * com requireAdmin(), que depende de contexto de request (next/headers, Clerk) e
 * quebraria fora do HTTP. A server action so DELEGA para createProduct (ver
 * app/admin/produtos/actions.ts), entao a invariante de dominio (persistencia +
 * auditoria atomica) vive inteiramente em createProduct.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os
 * specs para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no
 * spec quebra no load. Por isso a MUTACAO roda num processo `tsx` separado
 * (tests/harness/estoque/_run-seam.ts; mesmo tsx que o runner usa p/ seed),
 * herdando DATABASE_URL; e o spec faz TODAS as assercoes via `pg`. Detalhes em
 * _run-seam.ts.
 *
 * Invariantes cobertas: cents-only, audit-same-tx, reserved-le-stock.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };

/** Chama createProduct via processo tsx; retorna o produto criado (ou lanca). */
function runCreateProduct(payload: unknown): SeamProduct {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, "createProduct"], {
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

test("estoque.product.create: cria produto, persiste Int em centavos e audita na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- passo 1: conta produtos iniciais N e linhas de audit_log iniciais A.
    const before = await client.query<{ products: string; audit: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "products")::text  AS products,
         (SELECT COUNT(*) FROM "audit_log")::text AS audit`,
    );
    const N = Number(before.rows[0].products);
    const A = Number(before.rows[0].audit);

    // --- passo 2: createProduct com input valido (sku unico por run; ids unicos).
    const sku = `HARNESS-${randomUUID().slice(0, 8).toUpperCase()}`;
    const input = {
      name: `Produto Harness ${randomUUID().slice(0, 6)}`,
      category: "Tin",
      sku,
      priceCents: 12999, // Int de centavos (R$ 129,99)
      discountPct: 15,
      stock: 7,
      badge: null,
      imageUrl: "",
      description: "Criado pelo harness DB-first.",
    };
    // Ator anonimo de dev (mock-first: sem Clerk os tres campos sao null — ver
    // getAuditActor em lib/data/audit.ts). A auditoria grava mesmo assim.
    const actor = { clerkUserId: null, email: null, role: null };

    const created = runCreateProduct({ actor, input });
    expect(created.id, "createProduct deve retornar o produto criado").toBeTruthy();

    // --- assert: products ganha exatamente 1 linha (count == N+1).
    const afterCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"`,
    );
    expect(Number(afterCount.rows[0].count), "products deve ganhar 1 linha").toBe(N + 1);

    // --- assert: a linha persistida tem slug derivado do nome, isActive=true,
    //     reserved=0 e os valores numericos exatos como Int de centavos.
    const row = await client.query<{
      slug: string;
      is_active: boolean;
      reserved: number;
      stock: number;
      price_cents: number;
      discount_pct: number;
      sku: string;
    }>(
      `SELECT slug, is_active, reserved, stock, price_cents, discount_pct, sku
         FROM "products" WHERE id = $1`,
      [created.id],
    );
    expect(row.rowCount).toBe(1);
    const p = row.rows[0];

    // slug derivado do nome (slugify): minusculo, sem espacos, comeca com "produto-harness".
    expect(p.slug).toMatch(/^produto-harness-/);
    expect(p.slug).toBe(created.slug);
    expect(p.slug).not.toMatch(/[^a-z0-9-]/); // sem maiusculas/acentos/espacos

    expect(p.is_active, "produto novo nasce ativo").toBe(true);
    expect(p.reserved, "produto novo nasce com reserved=0").toBe(0);

    // cents-only: persistido EXATAMENTE como Int, sem float/arredondamento.
    expect(p.price_cents).toBe(12999);
    expect(Number.isInteger(p.price_cents)).toBe(true);
    expect(p.discount_pct).toBe(15);
    expect(Number.isInteger(p.discount_pct)).toBe(true);
    expect(p.stock).toBe(7);
    expect(Number.isInteger(p.stock)).toBe(true);
    expect(p.sku).toBe(sku);

    // --- assert: audit_log ganha exatamente 1 linha, action=product.create,
    //     entityType=product, before=null, after=snapshot, na MESMA transacao.
    const afterAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(Number(afterAudit.rows[0].count), "audit_log deve ganhar 1 linha").toBe(A + 1);

    const audit = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: unknown;
      after: { id: string; slug: string; priceCents: number; discountPct: number; stock: number };
    }>(
      `SELECT action, entity_type, entity_id, before, after
         FROM "audit_log" WHERE entity_id = $1`,
      [created.id],
    );
    expect(audit.rowCount, "1 linha de audit para este produto").toBe(1);
    const log = audit.rows[0];

    // action gravado com o valor DOTTED do enum (schema.prisma usa @map("product.create")).
    expect(log.action).toBe("product.create");
    expect(log.entity_type).toBe("product");
    expect(log.entity_id).toBe(created.id);
    expect(log.before, "create: before deve ser null").toBeNull();

    // after = snapshot do dominio (camelCase, *Cents inteiros) — coerente com a linha real.
    expect(log.after).toBeTruthy();
    expect(log.after.id).toBe(created.id);
    expect(log.after.slug).toBe(created.slug);
    expect(log.after.priceCents).toBe(12999);
    expect(log.after.discountPct).toBe(15);
    expect(log.after.stock).toBe(7);

    // --- assert: o CHECK products_reserved_le_stock_chk continua valido (existe e
    //     a linha nova respeita 0 <= reserved <= stock, com reserved=0).
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

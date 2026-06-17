import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.create-duplicate-sku (priority 2) — DB-first, sem browser.
 *
 * Prova que "criar produto com SKU duplicado (case-insensitive) e BLOQUEADO" contra
 * o Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO de product-create.spec.ts:
 * roda em Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: createProduct(actor, input) de lib/data/products.ts. A checagem de
 * SKU duplicado vive DENTRO da transacao (lib/data/products.ts: findFirst com
 * `mode: "insensitive"` ANTES do create) e lanca ProductValidationError, abortando a
 * transacao inteira — logo nem a linha de produto nem a de audit_log persistem
 * (rollback atomico). NAO chamamos a server action createProductAction porque ela
 * comeca com requireAdmin() (contexto de request: next/headers, Clerk), que quebra
 * fora do HTTP; ela so delega para createProduct.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta); o runner do Playwright transpila os specs
 * p/ CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no
 * load. Por isso a MUTACAO roda num processo `tsx` separado (_run-seam.ts), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`. O runner serializa o erro de
 * dominio como linha `__SEAM_ERROR__{name,message}` na stdout (exit 0).
 *
 * Invariante coberta: audit-same-tx (rollback NAO deixa audit orfao).
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };

/**
 * Chama createProduct via processo tsx. Em sucesso retorna o produto; em erro de
 * dominio (ProductValidationError) RELANCA com o mesmo name/message do produto,
 * para o spec poder assertar `rejects.toThrow`.
 */
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
    const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length)) as {
      name: string;
      message: string;
    };
    // Reconstroi o erro de dominio preservando name+message para os asserts.
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

test("estoque.product.create-duplicate-sku: SKU duplicado (case-insensitive) e bloqueado, sem produto nem audit (rollback)", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- passo 1: pega o sku de um produto existente do seed e conta N produtos / A audits.
    const existing = await client.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM "products" WHERE sku IS NOT NULL AND sku <> '' ORDER BY created_at ASC LIMIT 1`,
    );
    expect(existing.rowCount, "o seed deve ter ao menos 1 produto com sku").toBe(1);
    const existingSku = existing.rows[0].sku;
    const existingId = existing.rows[0].id;
    // O sku do seed precisa ter ao menos uma letra p/ a colisao case-insensitive
    // (UPPER) ser DISTINTA da string original; senao o teste nao provaria o "mode:
    // insensitive" (so provaria igualdade exata).
    expect(
      existingSku,
      "sku do seed deve conter letra p/ provar a colisao case-insensitive",
    ).toMatch(/[a-zA-Z]/);

    const before = await client.query<{ products: string; audit: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "products")::text  AS products,
         (SELECT COUNT(*) FROM "audit_log")::text AS audit`,
    );
    const N = Number(before.rows[0].products);
    const A = Number(before.rows[0].audit);

    // --- passo 2: createProduct com o MESMO sku em outra caixa (UPPER). Nome unico
    //     (slug derivado seria livre) para isolar a causa da falha no SKU, nao no nome.
    const dupSku = existingSku.toUpperCase();
    // Sanidade: se o sku do seed ja for todo maiusculo, UPPER == original — a colisao
    // continua valida (igualdade exata), mas a versao LOWER prova melhor o insensitive.
    const lowerSku = existingSku.toLowerCase();
    const uniqueName = `Produto Harness Dup ${randomUUID().slice(0, 8)}`;
    const baseInput = {
      name: uniqueName,
      category: "Tin",
      sku: dupSku,
      priceCents: 9999,
      discountPct: 0,
      stock: 3,
      badge: null,
      imageUrl: "",
      description: "Tentativa com SKU duplicado (harness DB-first).",
    };
    const actor = { clerkUserId: null, email: null, role: null };

    // --- assert: createProduct lanca ProductValidationError citando o SKU duplicado.
    let thrown: Error | null = null;
    try {
      runCreateProduct({ actor, input: baseInput });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown, "createProduct deve lancar com SKU duplicado").not.toBeNull();
    expect(thrown!.name).toBe("ProductValidationError");
    expect(thrown!.message).toMatch(/SKU/i);

    // Reforco da invariante case-insensitive: a versao toda-minuscula tambem colide,
    // SO se for de fato distinta da original (sku do seed nao era ja todo-minusculo).
    if (lowerSku !== existingSku) {
      let thrownLower: Error | null = null;
      try {
        runCreateProduct({
          actor,
          input: { ...baseInput, name: `${uniqueName} lower`, sku: lowerSku },
        });
      } catch (err) {
        thrownLower = err as Error;
      }
      expect(thrownLower, "SKU em minuscula tambem deve colidir (case-insensitive)").not.toBeNull();
      expect(thrownLower!.name).toBe("ProductValidationError");
    }

    // --- assert: products NAO ganha linha nova (count inalterado).
    const afterProducts = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"`,
    );
    expect(Number(afterProducts.rows[0].count), "products nao pode ganhar linha").toBe(N);

    // Nenhuma linha extra com o sku alvo: continua existindo SO o produto do seed
    // (a comparacao por LOWER cobre qualquer caixa que tivesse sido gravada).
    const sameSku = await client.query<{ id: string }>(
      `SELECT id FROM "products" WHERE LOWER(sku) = LOWER($1)`,
      [existingSku],
    );
    expect(sameSku.rowCount, "deve haver exatamente 1 produto com esse SKU (o do seed)").toBe(1);
    expect(sameSku.rows[0].id, "e e o produto original do seed").toBe(existingId);

    // --- assert: audit_log NAO ganha linha (rollback da transacao inteira: o
    //     ProductValidationError e lancado DENTRO da $transaction, antes/ao redor do
    //     writeAuditLog, entao nada de audit orfao). Invariante audit-same-tx.
    const afterAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(Number(afterAudit.rows[0].count), "audit_log nao pode ganhar linha (rollback)").toBe(A);

    // E nao ha nenhuma linha de product.create com o nome unico que tentamos criar.
    const orphanAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE action = 'product.create' AND after->>'name' = $1`,
      [uniqueName],
    );
    expect(Number(orphanAudit.rows[0].count), "nenhum audit orfao do create abortado").toBe(0);

    // --- rede final: CHECK 0<=reserved<=stock segue valido (nenhuma linha viola).
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products" WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
  } finally {
    await client.end();
  }
});

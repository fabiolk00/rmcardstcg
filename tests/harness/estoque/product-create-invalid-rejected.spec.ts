import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.create-invalid-rejected (priority 3) — DB-first, sem browser.
 *
 * Prova que "criar produto com valores invalidos (preco/desconto/estoque) e
 * REJEITADO" contra o Postgres efemero REAL exposto em process.env.DATABASE_URL
 * pelo runner (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO de
 * product-create.spec.ts / product-create-duplicate-sku.spec.ts: roda em Node
 * (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: createProduct(actor, input) de lib/data/products.ts. A validacao
 * de dominio vive em normalizeProductInput, chamada NO TOPO de createProduct, ANTES
 * de abrir a prisma.$transaction (lib/data/products.ts L228). Logo, cada input
 * invalido lanca ProductValidationError antes de qualquer escrita: a transacao nunca
 * abre -> nenhum produto e nenhum audit_log persistem. NAO chamamos a server action
 * createProductAction porque ela comeca com requireAdmin() (contexto de request:
 * next/headers, Clerk), que quebra fora do HTTP; ela so delega para createProduct.
 *
 * Casos de invalidez cobertos (cada um deve ser REJEITADO):
 *   - priceCents negativo            (preco>=0 inteiro)
 *   - priceCents nao-inteiro         (cents-only: so Int de centavos)
 *   - discountPct=81 (acima de 80)   (desconto 0..80)
 *   - discountPct nao-inteiro        (cents-only/derivacao integra: so Int)
 *   - stock negativo                 (estoque>=0 inteiro)
 *   - stock nao-inteiro              (estoque inteiro)
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta); o runner do Playwright transpila os specs
 * p/ CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no
 * load. Por isso a MUTACAO roda num processo `tsx` separado (_run-seam.ts, INFRA ja
 * existente), herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`. O runner
 * serializa o erro de dominio como linha `__SEAM_ERROR__{name,message}` na stdout
 * (exit 0).
 *
 * Invariantes cobertas: cents-only (so Int de centavos), final-price-derived
 * (discountPct so Int -> finalPriceCents derivado integro), audit-same-tx (rejeicao
 * NAO deixa produto nem audit orfao: a transacao nem chega a abrir).
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };

/**
 * Chama createProduct via processo tsx. Em sucesso retorna o produto; em erro de
 * dominio (ProductValidationError) RELANCA preservando name+message, para o spec
 * poder assertar o tipo e a mensagem.
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

/** Tenta criar e captura o erro lancado (ou null se NAO lancou). */
function attemptCreate(payload: unknown): Error | null {
  try {
    runCreateProduct(payload);
    return null;
  } catch (err) {
    return err as Error;
  }
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const ACTOR = { clerkUserId: null, email: null, role: null };

/** Input base VALIDO; cada caso sobrescreve so o campo que torna invalido. */
function validBase(name: string) {
  return {
    name,
    category: "Tin",
    sku: `HARNESS-INV-${randomUUID().slice(0, 8).toUpperCase()}`,
    priceCents: 9999,
    discountPct: 10,
    stock: 5,
    badge: null,
    imageUrl: "",
    description: "Tentativa invalida (harness DB-first).",
  };
}

test("estoque.product.create-invalid-rejected: cada input invalido (preco/desconto/estoque) e rejeitado, sem produto nem audit", async () => {
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

    // --- passo 2: cada caso invalido tem nome+sku UNICOS (p/ depois provar, via
    //     audit/produto, que NENHUM deles deixou rastro). O sku unico tambem garante
    //     que a rejeicao vem da validacao de faixa, nao de colisao de SKU.
    type Case = {
      label: string;
      // sobrescreve campos do validBase para tornar invalido
      patch: Record<string, unknown>;
      expectMessage: RegExp;
    };

    const cases: Case[] = [
      {
        label: "priceCents negativo",
        patch: { priceCents: -1 },
        expectMessage: /Pre[cç]o inv[aá]lido/i,
      },
      {
        label: "priceCents nao-inteiro (float)",
        patch: { priceCents: 1999.5 },
        expectMessage: /Pre[cç]o inv[aá]lido/i,
      },
      {
        label: "discountPct=81 (acima de 80)",
        patch: { discountPct: 81 },
        expectMessage: /Desconto inv[aá]lido/i,
      },
      {
        label: "discountPct nao-inteiro (float)",
        patch: { discountPct: 10.5 },
        expectMessage: /Desconto inv[aá]lido/i,
      },
      {
        label: "stock negativo",
        patch: { stock: -3 },
        expectMessage: /Estoque inv[aá]lido/i,
      },
      {
        label: "stock nao-inteiro (float)",
        patch: { stock: 4.2 },
        expectMessage: /Estoque inv[aá]lido/i,
      },
    ];

    // Nomes unicos por caso, para depois consultar o audit por nome.
    const names = cases.map(
      (c) => `Produto Harness Invalido ${c.label} ${randomUUID().slice(0, 8)}`,
    );

    // --- assert: cada chamada lanca ProductValidationError com a mensagem de faixa.
    cases.forEach((c, i) => {
      const input = { ...validBase(names[i]), ...c.patch };
      const thrown = attemptCreate({ actor: ACTOR, input });
      expect(thrown, `caso '${c.label}' deve lancar`).not.toBeNull();
      expect(thrown!.name, `caso '${c.label}': tipo do erro`).toBe("ProductValidationError");
      expect(thrown!.message, `caso '${c.label}': mensagem`).toMatch(c.expectMessage);
    });

    // Sanidade de contra-prova: o MESMO input base, sem o patch invalido, CRIARIA o
    // produto (a rejeicao acima vem so do campo invalido, nao de algo no input base).
    const sanityName = `Produto Harness Valido Sanidade ${randomUUID().slice(0, 8)}`;
    const sanity = runCreateProduct({ actor: ACTOR, input: validBase(sanityName) });
    expect(sanity.id, "input base valido deve criar (contra-prova)").toBeTruthy();

    // --- assert: products ganhou SO o produto de sanidade (count == N+1) e NENHUMA
    //     linha dos casos invalidos. audit_log idem (count == A+1, so o da sanidade).
    const afterProducts = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"`,
    );
    expect(
      Number(afterProducts.rows[0].count),
      "products: so o produto de sanidade entra (nenhum dos invalidos)",
    ).toBe(N + 1);

    const afterAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(afterAudit.rows[0].count),
      "audit_log: so o create da sanidade entra (nenhum dos invalidos)",
    ).toBe(A + 1);

    // Nenhum produto com os nomes dos casos invalidos (nem case-insensitive).
    const invalidNames = names;
    const leakedProducts = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products" WHERE name = ANY($1::text[])`,
      [invalidNames],
    );
    expect(
      Number(leakedProducts.rows[0].count),
      "nenhum produto dos casos invalidos foi persistido",
    ).toBe(0);

    // Nenhum audit product.create com os nomes dos casos invalidos (sem audit orfao).
    const leakedAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE action = 'product.create' AND after->>'name' = ANY($1::text[])`,
      [invalidNames],
    );
    expect(Number(leakedAudit.rows[0].count), "nenhum audit orfao dos creates rejeitados").toBe(0);

    // Nenhum produto com os SKUs invalidos (o sku do base e regenerado por chamada,
    // mas todos compartilham o prefixo HARNESS-INV-): so o de sanidade pode existir.
    const leakedBySku = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE sku LIKE 'HARNESS-INV-%' AND name <> $1`,
      [sanityName],
    );
    expect(
      Number(leakedBySku.rows[0].count),
      "nenhum produto invalido vazou pelo prefixo de SKU",
    ).toBe(0);

    // --- assert (final-price-derived/cents-only): products NAO tem coluna de preco
    //     final persistida e price_cents/discount_pct sao colunas inteiras (integer).
    //     A derivacao integra depende de discountPct ser Int — provado pela rejeicao
    //     do caso float acima.
    const cols = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'products'`,
    );
    const colNames = cols.rows.map((r) => r.column_name);
    expect(colNames, "products tem price_cents").toContain("price_cents");
    expect(colNames, "products tem discount_pct").toContain("discount_pct");
    // Nao existe coluna de preco final persistido (preco final e derivado por funcao pura).
    expect(colNames).not.toContain("final_price_cents");
    expect(colNames).not.toContain("final_price");
    const priceCol = cols.rows.find((r) => r.column_name === "price_cents");
    const discountCol = cols.rows.find((r) => r.column_name === "discount_pct");
    expect(priceCol?.data_type, "price_cents e inteiro (cents-only)").toBe("integer");
    expect(discountCol?.data_type, "discount_pct e inteiro (so Int)").toBe("integer");

    // --- rede final: CHECK 0<=reserved<=stock segue valido (nenhuma linha viola).
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products" WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
  } finally {
    await client.end();
  }
});

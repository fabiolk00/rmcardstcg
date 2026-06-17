import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.price.final-derived-pure (priority 16) — DB-first, sem browser.
 *
 * Prova "Preco final e derivado por funcao pura, nunca persistido" contra o
 * Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (product-available-derived.spec.ts): roda em Node (sem `page`), chama a SEAM de
 * PRODUCAO via processo tsx (_run-seam.ts) e assertaa o estado/derivacao real.
 *
 * ASSERTS DO LEDGER:
 *   [1] finalPriceCents == round(10000 * (1 - 10/100)) == 9000 (Int centavos).
 *       Provado chamando a FUNCAO DE PRODUCAO finalPriceCents (lib/data/pricing.ts)
 *       via seam, NAO replicando a conta em SQL — a spec exige que a FUNCAO REAL
 *       devolva 9000 e que o valor seja inteiro.
 *   [2] products NAO tem coluna de preco final/final_price (so price_cents e
 *       discount_pct). Provado via information_schema.columns.
 *   [3] finalPriceCents e funcao pura em lib/data/pricing.ts e NAO importa prisma.
 *       Provado (a) lendo o source on-disk e exigindo que ele exporte finalPriceCents
 *       e NAO importe prisma / lib/db / nada server-only; (b) empiricamente: a seam
 *       PURA computa o preco final isolada (sem abrir transacao nem tocar o banco)
 *       e devolve o numero — prova que a funcao nao depende de estado server-only.
 *
 * INVARIANTES: final-price-derived, cents-only, pure-client-safe.
 *   - final-price-derived: finalPriceCents(p) = round(priceCents*(1-discountPct/100));
 *     NUNCA persistido (sem coluna final_price). Reforco de paridade: o valor da
 *     FUNCAO REAL bate com round(price_cents*(1-discount_pct/100)) sobre um produto
 *     REALMENTE persistido no banco.
 *   - cents-only: a funcao devolve Int de centavos (Number.isInteger); price_cents e
 *     discount_pct sao colunas integer no DB (information_schema). Casos de
 *     arredondamento (Math.round) provam que o resultado nunca vaza float.
 *   - pure-client-safe: finalPriceCents nao importa prisma/server-only (assert [3]);
 *     a seam PURA roda sem transacao/conexao, confirmando o isolamento.
 *
 * SEAM escolhida: finalPriceCents(p) de lib/data/pricing.ts (funcao PURA), invocada
 * via _run-seam.ts (case 'finalPriceCents' — extensao de INFRA de teste; o case NAO
 * abre prisma.$transaction, exatamente para provar a pureza). Para o reforco de
 * paridade persistida, createProduct(actor, input) cria um produto PROPRIO (sem
 * tocar o seed) com priceCents=10000/discountPct=10.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso a chamada de seam roda num processo `tsx` separado
 * (tests/harness/estoque/_run-seam.ts), herdando DATABASE_URL; o spec assertaa via
 * `pg` e le o source de pricing.ts via `fs`.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");
const PRICING_SRC = path.join(__dirname, "..", "..", "..", "lib", "data", "pricing.ts");

type SeamProduct = { id: string; slug: string };

/** Chama uma op do seam via processo tsx e devolve a linha __SEAM_RESULT__ crua. */
function runSeamRaw(op: string, payload: unknown): string {
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
  return okLine.slice("__SEAM_RESULT__".length);
}

/** finalPriceCents REAL via seam PURA — devolve o numero derivado. */
function finalPriceCentsSeam(priceCents: number, discountPct: number): number {
  return JSON.parse(runSeamRaw("finalPriceCents", { priceCents, discountPct })) as number;
}

/** createProduct REAL via seam — devolve { id, slug }. */
function createProductSeam(payload: unknown): SeamProduct {
  return JSON.parse(runSeamRaw("createProduct", payload)) as SeamProduct;
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const PRICE = 10000; // R$100,00 (base, em centavos)
const DISCOUNT = 10; // 10% => round(10000*0.90) = 9000
const EXPECTED_FINAL = 9000;

test("estoque.price.final-derived-pure: preco final derivado por funcao pura, nunca persistido", async () => {
  // ---------------------------------------------------------------------------
  // ASSERT [1] — finalPriceCents REAL devolve round(10000*(1-10/100)) == 9000.
  //   Chamamos a FUNCAO DE PRODUCAO via seam (nao SQL). Resultado deve ser Int.
  // ---------------------------------------------------------------------------
  const finalReal = finalPriceCentsSeam(PRICE, DISCOUNT);
  expect(finalReal, "finalPriceCents(10000, 10%) = round(10000*0.90) = 9000").toBe(EXPECTED_FINAL);
  expect(Number.isInteger(finalReal), "preco final e Int de centavos (cents-only)").toBe(true);

  // Anti-trivialidade (cents-only / Math.round): casos que EXERCITAM o
  // arredondamento e os limites de faixa — provam a LOGICA da funcao real, nao a
  // constante 9000. Cada par {priceCents, discountPct} passa pela FUNCAO REAL.
  const cases: Array<{ price: number; disc: number; expect: number }> = [
    { price: 0, disc: 0, expect: 0 }, // borda inferior
    { price: 10000, disc: 0, expect: 10000 }, // sem desconto => base intocada
    { price: 10000, disc: 80, expect: 2000 }, // desconto maximo da faixa (0..80)
    { price: 333, disc: 10, expect: 300 }, // round(333*0.9)=round(299.7)=300 (arredonda p/ CIMA)
    { price: 199, disc: 50, expect: 100 }, // round(199*0.5)=round(99.5)=100 (round half-up)
    { price: 101, disc: 50, expect: 51 }, // round(101*0.5)=round(50.5)=51 (nunca vaza .5)
    { price: 12999, disc: 15, expect: 11049 }, // round(12999*0.85)=round(11049.15)=11049
  ];
  for (const c of cases) {
    const got = finalPriceCentsSeam(c.price, c.disc);
    expect(got, `finalPriceCents(${c.price}, ${c.disc}%) == ${c.expect}`).toBe(c.expect);
    expect(Number.isInteger(got), `finalPriceCents(${c.price}, ${c.disc}%) e Int`).toBe(true);
  }

  // ---------------------------------------------------------------------------
  // ASSERT [3] (parte estatica) — finalPriceCents e PURA em lib/data/pricing.ts e
  //   NAO importa prisma (nem lib/db / generated/prisma / nada server-only).
  //   Lemos o source on-disk e asseramos imports e export.
  // ---------------------------------------------------------------------------
  const src = readFileSync(PRICING_SRC, "utf8");
  expect(src, "pricing.ts deve exportar a funcao finalPriceCents").toMatch(
    /export\s+function\s+finalPriceCents\b/,
  );
  // Coleta todos os specifiers de import do modulo.
  const importSpecifiers = [...src.matchAll(/import\s+[^;]*?from\s+["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
  // NENHUM import pode ser de prisma / lib/db / cliente gerado / runtime de prisma.
  const serverOnly = importSpecifiers.filter((spec) =>
    /(^|\/)prisma(\b|\/|$)|@prisma\/|lib\/db\b|generated\/prisma|\/db$|adapter-pg/i.test(spec),
  );
  expect(
    serverOnly,
    `finalPriceCents nao pode importar prisma/server-only; achei: ${serverOnly.join(", ")}`,
  ).toEqual([]);
  // O unico import esperado e o TYPE Product (type-only, apagado na compilacao).
  for (const spec of importSpecifiers) {
    expect(
      /\.\/types$|lib\/data\/types$/.test(spec),
      `import inesperado em pricing.ts: ${spec}`,
    ).toBe(true);
  }
  // Reforco empirico de pureza: a seam 'finalPriceCents' acabou de rodar e
  // devolver um numero SEM o case abrir prisma.$transaction nem conexao — ja
  // exercitado nos asserts acima (se a funcao dependesse de server-only o import
  // do modulo quebraria o tsx ou exigiria o banco). Isolamento confirmado.

  // ---------------------------------------------------------------------------
  // ASSERT [2] + paridade persistida — exige um produto REAL no banco.
  // ---------------------------------------------------------------------------
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const actor = { clerkUserId: null, email: null, role: null };
    const created = createProductSeam({
      actor,
      input: {
        name: `Produto Harness FinalPrice ${tag}`,
        category: "Booster Box",
        sku: `HARNESS-FINALPRICE-${tag}`,
        priceCents: PRICE,
        discountPct: DISCOUNT,
        stock: 7,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para final-derived-pure",
      },
    });
    const productId = created.id;

    // --- ASSERT [2]: products NAO tem coluna de preco final.
    const cols = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'products'
         ORDER BY column_name`,
    );
    const colNames = cols.rows.map((c) => c.column_name);
    // As colunas-fonte existem...
    expect(colNames, "products deve ter coluna price_cents").toContain("price_cents");
    expect(colNames, "products deve ter coluna discount_pct").toContain("discount_pct");
    // ...mas NENHUMA coluna de preco final persistida.
    const finalPriceCols = colNames.filter((c) =>
      /final.?price|preco.?final|price.?final/i.test(c),
    );
    expect(
      finalPriceCols,
      `nenhuma coluna de preco final deve existir (so derivado); achei: ${finalPriceCols.join(", ")}`,
    ).toEqual([]);

    // --- cents-only: price_cents e discount_pct sao integer no DB.
    const typeOf = (name: string) => cols.rows.find((c) => c.column_name === name)?.data_type;
    expect(typeOf("price_cents"), "price_cents e integer (cents-only)").toBe("integer");
    expect(typeOf("discount_pct"), "discount_pct e integer (cents-only)").toBe("integer");

    // --- paridade (final-price-derived): a FUNCAO REAL bate com a derivacao SQL
    //     sobre o produto REALMENTE persistido (price_cents/discount_pct lidos crus).
    const row = await client.query<{
      price_cents: number;
      discount_pct: number;
      final_price_cents: number;
    }>(
      `SELECT price_cents, discount_pct,
              round(price_cents * (1 - discount_pct / 100.0))::int AS final_price_cents
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(row.rowCount).toBe(1);
    const p = row.rows[0];
    expect(p.price_cents, "price_cents persistido = 10000 (base intocada)").toBe(PRICE);
    expect(p.discount_pct, "discount_pct persistido = 10").toBe(DISCOUNT);
    expect(p.final_price_cents, "derivacao SQL = 9000").toBe(EXPECTED_FINAL);
    // A FUNCAO DE PRODUCAO, alimentada com os valores CRUS do banco, devolve o mesmo.
    const finalFromDb = finalPriceCentsSeam(p.price_cents, p.discount_pct);
    expect(finalFromDb, "finalPriceCents(valores do DB) == derivacao SQL == 9000 (paridade)").toBe(
      EXPECTED_FINAL,
    );
    expect(finalFromDb).toBe(p.final_price_cents);
  } finally {
    await client.end();
  }
});

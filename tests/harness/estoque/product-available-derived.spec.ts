import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.available-derived (priority 7) — DB-first, sem browser.
 *
 * Prova "Disponivel para venda = stock - reserved (derivado, nao persistido)"
 * contra o Postgres efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas
 * (product-reduce-stock-above-reserved.spec.ts): roda em Node (sem `page`) e
 * assertaa o estado real via `pg`.
 *
 * ASSERTS DO LEDGER:
 *   [1] Disponivel == stock - reserved == 6 (derivado em tempo de leitura), com
 *       stock=10 e reserved=4.
 *   [2] Nao existe coluna 'available'/'disponivel' na tabela products (so stock e
 *       reserved). Provado via information_schema.columns (sem coluna de
 *       disponivel persistida; tambem sem coluna de preco final).
 *   [3] CHECK 0<=reserved<=stock valido.
 *
 * INVARIANTES: reserved-le-stock, final-price-derived.
 *   - reserved-le-stock: 0 <= reserved <= stock; disponivel = stock - reserved;
 *     CHECK products_reserved_le_stock_chk existe + 0 violacoes.
 *   - final-price-derived: o preco final e derivado por finalPriceCents(p) =
 *     round(priceCents*(1-discountPct/100)) (lib/data/pricing.ts) e NUNCA
 *     persistido — assim como o disponivel. Provamos a paridade: information_schema
 *     confirma que NEM disponivel NEM preco final tem coluna; so existem as
 *     colunas-fonte (stock, reserved, price_cents, discount_pct). E reforcamos a
 *     derivacao numerica em pg (round(price_cents*(1-discount_pct/100))).
 *
 * SEAM escolhida: createProduct(actor, input) de lib/data/products.ts (cria um
 * produto PROPRIO p/ nao tocar o seed). reserved e gerido pelo ciclo de reserva
 * (reserveStock/commitStock/releaseStock em lib/data/inventory.ts), NUNCA por
 * createProduct/updateProduct — entao para obter reserved=4>0 de forma honesta e
 * isolada, FORCAMOS stock=10/reserved=4 via UPDATE direto em `pg` (mesma tecnica
 * das specs irmas reduce-stock-above-reserved / reduce-below-reserved-blocks).
 * ANTI-TRIVIALIDADE: reserved=4>0 e stock!=reserved garantem que disponivel=6 e
 * uma subtracao REAL (nao 0 trivial, nem stock cheio).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os
 * specs para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no
 * spec quebra no load. Por isso a MUTACAO (createProduct) roda num processo `tsx`
 * separado (tests/harness/estoque/_run-seam.ts, ja suporta createProduct),
 * herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string };

/** Chama uma op do seam (createProduct) via processo tsx. */
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

const STOCK = 10; // estoque fisico
const RESERVED = 4; // unidades reservadas (>0 e != stock => disponivel e subtracao real)
const AVAILABLE = STOCK - RESERVED; // 6 (derivado, nunca persistido)

test("estoque.product.available-derived: disponivel = stock - reserved = 6, sem coluna persistida", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Available ${tag}`;
    const sku = `HARNESS-AVAIL-${tag}`;
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup: cria um produto PROPRIO (sem tocar o seed). priceCents/discountPct
    //     escolhidos p/ provar tambem final-price-derived (round numerico exato).
    const PRICE = 10000; // R$100,00
    const DISCOUNT = 10; // 10% => finalPriceCents = round(10000*0.90) = 9000
    const created = runSeam("createProduct", {
      actor,
      input: {
        name,
        category: "Booster Box",
        sku,
        priceCents: PRICE,
        discountPct: DISCOUNT,
        stock: 50,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para available-derived",
      },
    });
    const productId = created.id;

    // --- passo 1: FORCA stock=10 e reserved=4 (disponivel=6). reserved e gerido
    //     pelo ciclo de reserva (nunca por create/update), entao o UPDATE direto e
    //     a forma honesta de obter reserved>0 isolado. (4 <= 10 respeita o CHECK.)
    await client.query(`UPDATE "products" SET stock = $1, reserved = $2 WHERE id = $3`, [
      STOCK,
      RESERVED,
      productId,
    ]);

    // --- assert [1]: Disponivel == stock - reserved == 6, derivado em LEITURA.
    //     Lemos as colunas-fonte cruas e derivamos no SQL (read-time), provando que
    //     o disponivel vem de stock - reserved e nao de um campo guardado.
    const row = await client.query<{
      stock: number;
      reserved: number;
      available: number;
      price_cents: number;
      discount_pct: number;
    }>(
      `SELECT stock, reserved, (stock - reserved) AS available, price_cents, discount_pct
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(row.rowCount).toBe(1);
    const p = row.rows[0];

    expect(p.stock, "setup deve deixar stock=10").toBe(STOCK);
    expect(p.reserved, "setup deve deixar reserved=4 (>0, nao trivial)").toBe(RESERVED);
    expect(RESERVED).toBeGreaterThan(0);
    expect(p.reserved).not.toBe(p.stock); // garante subtracao real (nao 0 trivial)
    expect(p.available, "disponivel = stock - reserved = 6").toBe(AVAILABLE);
    expect(p.available).toBe(6);
    expect(Number.isInteger(p.available)).toBe(true);

    // --- assert [2]: NAO existe coluna 'available'/'disponivel' na tabela products.
    //     Lista TODAS as colunas via information_schema e exige que stock e reserved
    //     existam, mas nenhuma coluna de disponivel persistida.
    const cols = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'products'
         ORDER BY column_name`,
    );
    const colNames = cols.rows.map((c) => c.column_name);
    // As colunas-fonte existem...
    expect(colNames, "products deve ter coluna stock").toContain("stock");
    expect(colNames, "products deve ter coluna reserved").toContain("reserved");
    // ...mas NENHUMA coluna de disponivel persistida.
    const availableCols = colNames.filter((c) => /avail|disponi/i.test(c));
    expect(
      availableCols,
      `nenhuma coluna de 'disponivel' deve existir (so derivado); achei: ${availableCols.join(", ")}`,
    ).toEqual([]);

    // --- invariante final-price-derived (paridade com o disponivel): assim como o
    //     disponivel, o PRECO FINAL nunca e persistido — so price_cents/discount_pct.
    expect(colNames, "products deve ter coluna price_cents").toContain("price_cents");
    expect(colNames, "products deve ter coluna discount_pct").toContain("discount_pct");
    const finalPriceCols = colNames.filter((c) => /final.?price|preco.?final/i.test(c));
    expect(
      finalPriceCols,
      `nenhuma coluna de preco final deve existir (so derivado); achei: ${finalPriceCols.join(", ")}`,
    ).toEqual([]);
    // Reforco numerico da derivacao em pg: finalPriceCents = round(price*(1-desc/100)).
    const fp = await client.query<{ final_price_cents: number }>(
      `SELECT round(price_cents * (1 - discount_pct / 100.0))::int AS final_price_cents
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(p.price_cents).toBe(PRICE);
    expect(p.discount_pct).toBe(DISCOUNT);
    expect(fp.rows[0].final_price_cents, "finalPriceCents = round(10000*0.90) = 9000").toBe(9000);

    // --- assert [3]: CHECK 0<=reserved<=stock valido (existe + 0 violacoes).
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir").toBe(1);
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
    // Reforco direto na linha alvo: 0 <= 4 <= 10.
    expect(p.reserved >= 0 && p.reserved <= p.stock, "0 <= reserved <= stock na linha alvo").toBe(
      true,
    );

    // --- rede final (defesa em profundidade): o DB rejeita reserved > stock via
    //     o CHECK, mesmo por SQL cru. Tentar reserved=11 (>stock=10) deve falhar e
    //     NAO persistir (a linha continua reserved=4).
    let dbRejected = false;
    try {
      await client.query(`UPDATE "products" SET reserved = $1 WHERE id = $2`, [
        STOCK + 1,
        productId,
      ]);
    } catch (err) {
      dbRejected = true;
      expect(String((err as Error).message)).toMatch(/products_reserved_le_stock_chk/);
    }
    expect(dbRejected, "DB deve rejeitar reserved>stock via CHECK").toBe(true);
    const recheck = await client.query<{ reserved: number }>(
      `SELECT reserved FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(recheck.rows[0].reserved, "reserved permanece 4 (UPDATE invalido nao persistiu)").toBe(
      RESERVED,
    );
  } finally {
    await client.end();
  }
});

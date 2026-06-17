import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.reactivate-audited (priority 19) — DB-first, sem browser.
 *
 * Prova "admin reativa produto inativo com auditoria" contra o Postgres efemero
 * REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO da spec irma
 * (product-inactivate-audited.spec.ts): roda em Node (sem `page`) e assertaa o
 * estado real via `pg`.
 *
 * SEAM escolhida: setProductActive(actor, id, true) de lib/data/products.ts — a
 * funcao de menor nivel que prova a invariante (prisma.$transaction { le before;
 * se ja no estado pedido, no-op idempotente; senao UPDATE is_active +
 * writeAuditLog na MESMA tx, action product.reactivate quando isActive=true,
 * before/after snapshots }). NAO chamamos a server action setProductActiveAction
 * porque ela comeca com requireAdmin() (contexto de request: next/headers, Clerk),
 * que quebra fora do HTTP; a action so DELEGA para setProductActive.
 *
 * DADOS PROPRIOS: criamos um produto PROPRIO via createProduct (SKU/nome unicos por
 * run), ATIVO; depois o INATIVAMOS via setProductActive(false) p/ chegar ao
 * pre-estado da feature (isActive=false). So entao chamamos a acao-sob-teste
 * setProductActive(true). Antes de reativar, FORCAMOS reserved>0 (UPDATE direto na
 * fixture, respeitando o CHECK reserved<=stock) para que o assert "estado de
 * estoque inalterado" NAO vire trivial. Nao tocamos o seed.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente
 * Prisma gerado e ESM puro (import.meta). O runner do Playwright transpila os specs
 * para CJS, onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra
 * no load. Por isso as chamadas de seam (createProduct/setProductActive) rodam num
 * processo `tsx` separado (tests/harness/estoque/_run-seam.ts, que JA suporta o case
 * setProductActive — NENHUMA extensao de runner foi necessaria), herdando
 * DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Invariantes cobertas: audit-same-tx.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamOp = "createProduct" | "setProductActive";

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

type SeamProduct = { id: string; slug: string; isActive: boolean };

/** Chama uma op que retorna um produto; falha o teste se vier erro de dominio. */
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

const P = 31999; // priceCents base (intocado pela reativacao)
const DISC = 15; // desconto (intocado)
const STOCK = 9; // estoque (intocado)
const RESERVED = 3; // reserved FORCADO > 0 p/ tornar "estado de estoque inalterado" nao-trivial

test("estoque.product.reactivate-audited: isActive false->true, audita product.reactivate na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const name = `Produto Harness Reactivate ${tag}`;
    const sku = `HARNESS-REACT-${tag}`;
    const actor = { clerkUserId: null, email: null, role: null };

    // --- setup: cria um produto PROPRIO (sem tocar o seed), ATIVO, com valores
    //     numericos concretos. createProduct ja grava 1 audit (product.create).
    const created = runProductSeam("createProduct", {
      actor,
      input: {
        name,
        category: "Booster Box",
        sku,
        priceCents: P,
        discountPct: DISC,
        stock: STOCK,
        badge: null,
        imageUrl: "/products/placeholder.svg",
        description: "fixture do harness para reactivate-audited",
      },
    });
    const productId = created.id;
    expect(created.isActive, "produto nasce ativo").toBe(true);

    // --- setup 2: FORCA reserved>0 (UPDATE direto na fixture). Sem isto o assert
    //     "estado de estoque inalterado" seria trivial (reserved=0 antes e depois).
    //     Respeita o CHECK products_reserved_le_stock_chk (0 <= RESERVED <= STOCK).
    await client.query(`UPDATE "products" SET reserved = $1 WHERE id = $2`, [RESERVED, productId]);

    // --- setup 3: INATIVA o produto (chega ao pre-estado da feature: isActive=false).
    //     Esta chamada grava 1 audit product.inactivate (a 2a deste produto).
    const inactivated = runProductSeam("setProductActive", {
      actor,
      id: productId,
      isActive: false,
    });
    expect(inactivated.isActive, "setup deve deixar o produto inativo").toBe(false);

    // Snapshot pre-reativacao: is_active=false e os campos que NAO podem mudar.
    const pre = await client.query<{
      is_active: boolean;
      price_cents: number;
      discount_pct: number;
      stock: number;
      reserved: number;
      slug: string;
      sku: string;
    }>(
      `SELECT is_active, price_cents, discount_pct, stock, reserved, slug, sku
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(pre.rowCount).toBe(1);
    const p0 = pre.rows[0];
    expect(p0.is_active, "setup deixa o produto INATIVO (pre-estado da feature)").toBe(false);
    expect(p0.reserved, "setup forcou reserved>0 (assert nao-trivial)").toBe(RESERVED);
    expect(p0.price_cents).toBe(P);
    expect(p0.discount_pct).toBe(DISC);
    expect(p0.stock).toBe(STOCK);

    // Contagens iniciais (apos create + inactivate): total de produtos (p/ provar que
    // reativar nao cria/remove linha) e audit_log (total + por entidade) p/ provar
    // "exatamente 1 linha nova" pela reativacao.
    const beforeCounts = await client.query<{
      products: string;
      auditTotal: string;
      auditEntity: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM "products")::text AS products,
         (SELECT COUNT(*) FROM "audit_log")::text AS "auditTotal",
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS "auditEntity"`,
      [productId],
    );
    const productsBefore = Number(beforeCounts.rows[0].products);
    const auditTotalBefore = Number(beforeCounts.rows[0].auditTotal);
    const auditEntityBefore = Number(beforeCounts.rows[0].auditEntity);
    expect(
      auditEntityBefore,
      "create (1) + inactivate (1) ja deixaram 2 audits deste produto",
    ).toBe(2);

    // --- passo 2 (acao-sob-teste): chama setProductActive(actor, id, true).
    const result = runProductSeam("setProductActive", { actor, id: productId, isActive: true });
    expect(result.id, "setProductActive deve retornar o produto").toBe(productId);
    expect(result.isActive, "retorno reflete isActive=true").toBe(true);

    // --- assert [1]: products.isActive == true; NENHUMA linha removida/criada.
    const after = await client.query<{
      is_active: boolean;
      price_cents: number;
      discount_pct: number;
      stock: number;
      reserved: number;
      slug: string;
      sku: string;
    }>(
      `SELECT is_active, price_cents, discount_pct, stock, reserved, slug, sku
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(after.rowCount, "a linha continua existindo (1 unica)").toBe(1);
    const p1 = after.rows[0];
    expect(p1.is_active, "isActive deve passar a true").toBe(true);

    const productsAfter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"`,
    );
    expect(
      Number(productsAfter.rows[0].count),
      "reativar NAO cria/remove linha: contagem de produtos inalterada",
    ).toBe(productsBefore);

    // --- reforco: estado de estoque/preco INALTERADO (so is_active mudou).
    expect(p1.price_cents, "priceCents inalterado").toBe(P);
    expect(p1.discount_pct, "discountPct inalterado").toBe(DISC);
    expect(p1.stock, "stock inalterado").toBe(STOCK);
    expect(p1.reserved, "reserved (>0) inalterado pela reativacao").toBe(RESERVED);
    expect(p1.slug, "slug inalterado").toBe(p0.slug);
    expect(p1.sku, "sku inalterado").toBe(p0.sku);

    // --- assert [2]: audit_log recebe EXATAMENTE 1 linha nova, action=product.reactivate,
    //     before.isActive=false, after.isActive=true, na MESMA transacao.
    const afterAudit = await client.query<{ total: string; entity: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "audit_log")::text AS total,
         (SELECT COUNT(*) FROM "audit_log" WHERE entity_id = $1)::text AS entity`,
      [productId],
    );
    expect(Number(afterAudit.rows[0].total), "audit_log total deve ganhar 1 linha").toBe(
      auditTotalBefore + 1,
    );
    expect(Number(afterAudit.rows[0].entity), "este produto deve ganhar 1 linha de audit").toBe(
      auditEntityBefore + 1,
    );

    const log = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: {
        isActive: boolean;
        priceCents: number;
        discountPct: number;
        stock: number;
      } | null;
      after: {
        isActive: boolean;
        priceCents: number;
        discountPct: number;
        stock: number;
      } | null;
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

    // action gravado com o valor DOTTED do enum (schema.prisma usa @map("product.reactivate")).
    expect(a.action, "action deve ser o @map dotted product.reactivate (nao a chave JS)").toBe(
      "product.reactivate",
    );
    expect(a.entity_type).toBe("product");
    expect(a.entity_id).toBe(productId);

    expect(a.before, "reactivate: before deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.after, "reactivate: after deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.before!.isActive, "before.isActive deve ser false").toBe(false);
    expect(a.after!.isActive, "after.isActive deve ser true").toBe(true);
    // delta limpo: preco/desconto/estoque iguais nos dois snapshots (so o flag mudou).
    expect(a.before!.priceCents).toBe(P);
    expect(a.after!.priceCents).toBe(P);
    expect(a.before!.discountPct).toBe(DISC);
    expect(a.after!.discountPct).toBe(DISC);
    expect(a.before!.stock).toBe(STOCK);
    expect(a.after!.stock).toBe(STOCK);

    // --- reforco anti-fake: nao deve haver linha product.inactivate NOVA pela reativacao
    //     (a unica inactivate e a do setup). A reativacao audita SO product.reactivate.
    const reactivateRows = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE entity_id = $1 AND action = 'product.reactivate'`,
      [productId],
    );
    expect(
      Number(reactivateRows.rows[0].count),
      "exatamente 1 linha product.reactivate p/ este produto",
    ).toBe(1);

    // --- reforco audit-same-tx: o CHECK reserved<=stock segue valido e nenhuma linha
    //     viola 0<=reserved<=stock (a reativacao nao corrompeu o invariante de estoque).
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"
         WHERE NOT (reserved >= 0 AND reserved <= stock)`,
    );
    expect(Number(violations.rows[0].count), "nenhuma linha viola 0<=reserved<=stock").toBe(0);
  } finally {
    await client.end();
  }
});

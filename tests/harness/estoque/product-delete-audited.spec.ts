import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: estoque.product.delete-audited — DB-first, sem browser.
 *
 * Prova o "D" do CRUD de produto (exclusao PERMANENTE) contra o Postgres efemero REAL
 * exposto em process.env.DATABASE_URL pelo runner (scripts/harness-with-ephemeral-pg.ts).
 * Segue o PADRAO das specs irmas VERDES product-inactivate-audited.spec.ts (asserts de
 * audit) e cupom-delete-used-blocked.spec.ts (caminho barrado + sanity de schema): roda
 * em Node (sem `page`) e assertaa o estado real via `pg`.
 *
 * SEAM escolhida: deleteProduct(actor, id) de lib/data/products.ts — a funcao de PRODUCAO
 * de MENOR NIVEL que carrega a guarda product-delete-guard. Numa MESMA prisma.$transaction
 * ela: (1) le o produto (before); se inexistente -> 'not_found'; (2) CONTA order_items
 * WHERE product_id=id e, se > 0, retorna 'in_use' SEM apagar e SEM gravar audit (historico
 * de pedido protegido); (3) senao faz o hard-delete + audit product.delete. NAO chamamos
 * deleteProductAction porque ela comeca com requireAdmin() (contexto de request: next/
 * headers, Clerk), que quebra fora do HTTP; a action so DELEGA para deleteProduct. Os seams
 * `createProduct`/`setProductActive`/`deleteProduct` (este arquivo, _run-seam.ts) sao INFRA
 * de teste — nenhum codigo de produto e tocado.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness): o cliente Prisma gerado e ESM puro
 * (import.meta). O runner do Playwright transpila os specs para CJS, onde import.meta e
 * SyntaxError — importar lib/data DIRETO no spec quebra no load. Por isso a MUTACAO roda num
 * processo `tsx` separado (_run-seam.ts), herdando DATABASE_URL; o spec assertaa via `pg`.
 *
 * Invariantes cobertas: audit-same-tx, product-delete-guard.
 */

const SEAM_RUNNER = path.join(__dirname, "_run-seam.ts");

type SeamProduct = { id: string; slug: string; isActive: boolean; imageUrl: string };
type ProductDeleteResult = { ok: true; id: string } | { ok: false; error: string };

/** Chama uma op do seam via processo tsx; devolve a linha __SEAM_RESULT__ parseada. */
function runSeam<T>(op: string, payload: unknown): T {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
    encoding: "utf8",
    // Herda DATABASE_URL do runner; payload via env (nao argv) p/ nao depender do quoting.
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
  return JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as T;
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

const ACTOR = { clerkUserId: null, email: null, role: null };

/** Input de produto valido (categoria semeada no DB efemero, como as specs irmas). */
function productInput(name: string, sku: string) {
  return {
    name,
    category: "Booster Box",
    sku,
    priceCents: 34990,
    discountPct: 0,
    stock: 7,
    badge: null,
    imageUrl: "/products/placeholder.svg",
    description: "fixture do harness para delete-audited",
  };
}

/** Cria um pedido PROPRIO minimo (INSERT direto em pg) e devolve seu id numerico. */
async function insertOrder(client: Client, tag: string): Promise<number> {
  const ins = await client.query<{ id: number }>(
    `INSERT INTO "orders" (
       clerk_user_id, customer_name, customer_email, customer_phone,
       address_cep, address_street, address_city, address_state,
       subtotal_cents, discount_cents, shipping_cents, total_cents,
       payment_status, payment_method, shipping_status,
       stock_reserved, stock_committed
     ) VALUES (
       $1, $2, $3, $4,
       '01001000', 'Rua Teste', 'Sao Paulo', 'SP',
       34990, 0, 0, 34990,
       'pending', 'pix', 'pending',
       false, false
     ) RETURNING id`,
    [`user-${tag}`, "Cliente Harness", `cliente-${tag}@harness.test`, "11999999999"],
  );
  return ins.rows[0].id;
}

test("estoque.product.delete-audited: produto sem venda e excluido (hard-delete), audita product.delete na mesma tx", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);
    const created = runSeam<SeamProduct>("createProduct", {
      actor: ACTOR,
      input: productInput(`Produto Harness Delete ${tag}`, `HARNESS-DEL-${tag}`),
    });
    const productId = created.id;
    expect(productId, "createProduct deve devolver id").toBeTruthy();

    // pre-condicao: o produto EXISTE e NAO tem order_items (anti-trivialidade: sem isso o
    // delete cairia no ramo not_found ou seria barrado por venda).
    const pre = await client.query<{ count: string; items: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "products" WHERE id = $1)::text AS count,
         (SELECT COUNT(*) FROM "order_items" WHERE product_id = $1)::text AS items`,
      [productId],
    );
    expect(Number(pre.rows[0].count), "produto semeado deve existir").toBe(1);
    expect(Number(pre.rows[0].items), "produto novo nao tem venda (order_items=0)").toBe(0);

    // contagens iniciais: total de produtos e audit_log (global) p/ deltas exatos.
    const before = await client.query<{ products: string; audit: string }>(
      `SELECT
         (SELECT COUNT(*) FROM "products")::text AS products,
         (SELECT COUNT(*) FROM "audit_log")::text AS audit`,
    );
    const productsBefore = Number(before.rows[0].products);
    const auditBefore = Number(before.rows[0].audit);

    // === ACAO: deleteProduct (deve suceder). =========================================
    const del = runSeam<ProductDeleteResult>("deleteProduct", { actor: ACTOR, id: productId });
    expect(del.ok, `exclusao de produto sem venda deve suceder: ${JSON.stringify(del)}`).toBe(true);
    if (!del.ok) throw new Error("inalcancavel");
    expect(del.id).toBe(productId);

    // === assert [1]: a linha SUMIU de products (hard-delete, nao soft). ================
    const gone = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(Number(gone.rows[0].count), "produto foi removido (hard-delete)").toBe(0);

    const productsAfter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "products"`,
    );
    expect(
      Number(productsAfter.rows[0].count),
      "hard-delete remove exatamente 1 linha de products",
    ).toBe(productsBefore - 1);

    // === assert [2]: audit_log ganha EXATAMENTE 1 linha product.delete (before nao-null,
    //     after null) na MESMA tx. entity_id UNICO por run isola do ruido do seed. ======
    const auditAfter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfter.rows[0].count),
      "delete grava exatamente 1 linha de audit (delta global +1)",
    ).toBe(auditBefore + 1);

    const log = await client.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      before: { id: string; isActive: boolean } | null;
      after: unknown | null;
    }>(
      `SELECT action, entity_type, entity_id, before, after
         FROM "audit_log" WHERE entity_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      [productId],
    );
    expect(log.rowCount, "deve haver 1 linha de audit para o produto excluido").toBe(1);
    const a = log.rows[0];
    // action gravado com o valor DOTTED do enum (schema.prisma usa @map("product.delete")).
    expect(a.action, "action deve ser o @map dotted product.delete").toBe("product.delete");
    expect(a.entity_type).toBe("product");
    expect(a.entity_id).toBe(productId);
    expect(a.before, "delete: before deve ser snapshot (nao-null)").toBeTruthy();
    expect(a.after, "delete: after deve ser null (registro deixou de existir)").toBeNull();
    expect(a.before!.id, "before.id deve ser o produto excluido").toBe(productId);
  } finally {
    await client.end();
  }
});

test("estoque.product.delete-audited: produto JA VENDIDO nao e excluido (in_use), linha persiste, sem audit; inativar e o caminho", async () => {
  const client = makeClient();
  await client.connect();
  try {
    // --- SANITY de schema: a FK order_items.product_id e onDelete:Restrict ('r'). E ela
    // (mais a guarda da aplicacao) que protege o historico de pedidos; sem RESTRICT a
    // invariante product-delete-guard seria vacua.
    const fk = await client.query<{ confdeltype: string }>(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname = 'order_items'
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.conrelid
               AND a.attnum = ANY (c.conkey)
               AND a.attname = 'product_id'
          )`,
    );
    expect(fk.rowCount, "FK em order_items.product_id deve existir").toBeGreaterThanOrEqual(1);
    expect(
      fk.rows.some((r) => r.confdeltype === "r"),
      "FK order_items.product_id deve ser onDelete RESTRICT ('r')",
    ).toBe(true);

    const tag = randomUUID().slice(0, 8);
    const created = runSeam<SeamProduct>("createProduct", {
      actor: ACTOR,
      input: productInput(`Produto Harness Vendido ${tag}`, `HARNESS-SOLD-${tag}`),
    });
    const productId = created.id;

    // --- torna o produto "ja vendido": um pedido PROPRIO + 1 order_item referenciando-o
    // (snapshot da compra). E o que a guarda protege (FK Restrict como rede final).
    const orderId = await insertOrder(client, tag);
    // order_items.id e uuid com @default(uuid()) GERADO NO CLIENTE pelo Prisma (nao ha
    // default no banco) — o INSERT cru precisa fornecer o id. Difere de orders.id, que e
    // autoincrement (SERIAL, default no banco), por isso insertOrder o omite.
    await client.query(
      `INSERT INTO "order_items" (id, product_id, order_id, product_name, quantity, unit_price_cents)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), productId, orderId, `Produto Harness Vendido ${tag}`, 2, 34990],
    );

    // pre-condicao anti-trivial: existe >=1 order_item p/ este produto (o ramo in_use).
    const hasItem = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "order_items" WHERE product_id = $1`,
      [productId],
    );
    expect(Number(hasItem.rows[0].count), "produto DEVE ter >=1 venda (order_item)").toBe(1);

    const baseAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const A0 = Number(baseAudit.rows[0].count);

    // === ACAO: deleteProduct (deve ser BARRADO). =====================================
    const del = runSeam<ProductDeleteResult>("deleteProduct", { actor: ACTOR, id: productId });

    // === A1: ok:false com a mensagem de "ja foi vendido" (in_use). ====================
    expect(del.ok, `exclusao de produto vendido deve FALHAR: ${JSON.stringify(del)}`).toBe(false);
    if (del.ok) throw new Error("inalcancavel: delete de produto vendido deveria ser ok:false");
    expect(
      del.error.startsWith("Produto já foi vendido"),
      `mensagem deve indicar in_use, veio: ${del.error}`,
    ).toBe(true);

    // === A2: a linha PERMANECE em products (nada apagado; FK Restrict + guarda). =======
    const still = await client.query<{ count: string; is_active: boolean }>(
      `SELECT COUNT(*)::text AS count, BOOL_AND(is_active) AS is_active
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(Number(still.rows[0].count), "a linha do produto PERMANECE (delete barrado)").toBe(1);
    expect(still.rows[0].is_active, "produto continua ativo apos delete barrado").toBe(true);

    // o order_item (historico da venda) tambem sobrevive intacto.
    const itemStill = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "order_items" WHERE product_id = $1`,
      [productId],
    );
    expect(Number(itemStill.rows[0].count), "historico da venda sobrevive (FK Restrict)").toBe(1);

    // === A3: audit_log NAO ganha linha (delta GLOBAL == 0; 0 linhas product.delete). ===
    const auditAfter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(Number(auditAfter.rows[0].count), "delete barrado NAO grava audit (delta 0)").toBe(A0);
    const delAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"
         WHERE action = 'product.delete' AND entity_id = $1`,
      [productId],
    );
    expect(
      Number(delAudit.rows[0].count),
      "0 linhas product.delete para esse produto (delete nunca procedeu)",
    ).toBe(0);

    // === A4: caminho correto e INATIVAR (setProductActive false), nao excluir. =========
    const deactivated = runSeam<SeamProduct>("setProductActive", {
      actor: ACTOR,
      id: productId,
      isActive: false,
    });
    expect(deactivated.isActive, "inativar (caminho correto) deixa isActive=false").toBe(false);

    const afterDeactivate = await client.query<{ count: string; is_active: boolean }>(
      `SELECT COUNT(*)::text AS count, BOOL_AND(is_active) AS is_active
         FROM "products" WHERE id = $1`,
      [productId],
    );
    expect(
      Number(afterDeactivate.rows[0].count),
      "inativar NAO apaga: produto continua existindo (soft, nao hard)",
    ).toBe(1);
    expect(
      afterDeactivate.rows[0].is_active,
      "is_active == false: produto saiu da loja sem ser excluido",
    ).toBe(false);
  } finally {
    await client.end();
  }
});

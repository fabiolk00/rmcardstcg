import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * SMOKE do harness de admin (mock-first, sem Clerk). Prova que o ambiente do
 * harness sobe (Postgres efemero REAL + seed — ver scripts/harness-with-ephemeral-pg.ts).
 *
 * O 1o teste (DB-first) e o gate VERDE: confirma que o banco efemero subiu, foi
 * seedado e tem os CHECKs aplicados. Os 3 ultimos testes tentam abrir as listas
 * de admin pela UI e ficam VERMELHOS por um BLOCKER de ambiente (ver abaixo) — o
 * smoke os mantem escritos como sinal honesto, NUNCA como verde inventado.
 *
 * Seletores RESILIENTES (caso o blocker seja resolvido um dia): <h1> por
 * role/nome (Produtos/Pedidos/Cupons), nunca classes CSS frageis.
 *
 * PADRAO DB-FIRST do harness: cada spec recebe um banco efemero recem-seedado e
 * assertaa estado conectando via `pg` usando process.env.DATABASE_URL (exposto
 * pelo runner). Nao ha servidor/banco persistente entre runs — cada run e
 * isolado. As specs de feature (estoque/pedido) seguirao este padrao: agir via
 * lib/data ou SQL e conferir colunas/CHECKs/audit_log no MESMO banco.
 *
 * NOTA mock-first: o LAYOUT (app/admin/layout.tsx) e o requireAdmin liberam
 * /admin com NODE_ENV != "production" (por isso o harness usa `next dev`). POReM
 * o MIDDLEWARE em proxy.ts (Next 16) chama clerkMiddleware + auth.protect() em
 * "/admin(.*)" de forma INCONDICIONAL (sem checar isClerkConfigured) — feito
 * assim de proposito para nao quebrar o bundle Edge na Vercel. Resultado: com
 * Clerk em branco, /admin redireciona para /entrar ANTES de renderizar.
 *
 * BLOCKER honesto: os 3 testes de rota abaixo ficam VERMELHOS por causa disso.
 * NAO devem ser "consertados" afrouxando proxy.ts/requireAdmin (codigo de produto
 * + seguranca). As specs de FEATURE do harness operam DB-FIRST (lib/data + pg),
 * NAO pela UI sobre HTTP — ver o teste verde de DATABASE_URL acima e
 * tests/harness/harness-progress.txt (secao BLOCKER).
 */

// Diagnostico: erros de runtime do cliente aparecem no log do Playwright.
test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error][${testInfo.title}] ${m.text()}`);
  });
});

test("o banco efemero esta seedado e acessivel via DATABASE_URL (padrao DB-first)", async () => {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const products = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "products"',
    );
    expect(Number(products.rows[0].count)).toBeGreaterThan(0);

    const orders = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "orders"',
    );
    expect(Number(orders.rows[0].count)).toBeGreaterThan(0);

    // O suplemento de schema (CHECKs) deve estar aplicado neste banco efemero.
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'products_reserved_le_stock_chk'`,
    );
    expect(chk.rowCount, "CHECK reserved<=stock deve existir (apply-test-constraints)").toBe(1);
  } finally {
    await client.end();
  }
});

// BLOCKER: ver cabecalho. proxy.ts (middleware Clerk) protege "/admin(.*)"
// incondicionalmente; com Clerk em branco o acesso redireciona p/ /entrar. Estes
// 3 testes ficam VERMELHOS de proposito como sinal honesto — NAO afrouxar produto.
const BLOCKER =
  "BLOCKER: proxy.ts protege /admin incondicionalmente (auth.protect); mock-first nao abre /admin via HTTP. Ver harness-progress.txt.";

test("/admin/produtos renderiza a lista (mock-first, sem login)", async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: "blocker", description: BLOCKER });
  await page.goto("/admin/produtos");
  // Se o gate/middleware redirecionasse, NAO veriamos o heading de admin.
  await expect(page).toHaveURL(/\/admin\/produtos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Produtos" })).toBeVisible();
});

test("/admin/pedidos renderiza a lista (mock-first, sem login)", async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: "blocker", description: BLOCKER });
  await page.goto("/admin/pedidos");
  await expect(page).toHaveURL(/\/admin\/pedidos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Pedidos" })).toBeVisible();
});

test("/admin/cupons renderiza a lista (mock-first, sem login)", async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: "blocker", description: BLOCKER });
  await page.goto("/admin/cupons");
  await expect(page).toHaveURL(/\/admin\/cupons$/);
  await expect(page.getByRole("heading", { level: 1, name: "Cupons" })).toBeVisible();
});

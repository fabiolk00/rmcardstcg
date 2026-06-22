import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * SMOKE do harness de admin (mock-first, sem Clerk). Prova que o ambiente do
 * harness sobe (Postgres efemero REAL + seed — ver scripts/harness-with-ephemeral-pg.ts)
 * e que as listas de admin renderizam mock-first via HTTP.
 *
 * O 1o teste (DB-first) e o gate VERDE da INFRA: confirma que o banco efemero subiu,
 * foi seedado e tem os CHECKs aplicados. Os 3 testes seguintes abrem as listas de
 * admin pela UI e conferem o <h1> por role/nome (Produtos/Pedidos/Cupons).
 *
 * Mock-first via HTTP (antes um BLOCKER, agora RESOLVIDO): o LAYOUT
 * (app/admin/layout.tsx) e o requireAdmin liberam /admin com NODE_ENV != "production"
 * (por isso o harness usa `next dev`). O MIDDLEWARE em proxy.ts (Next 16) agora gateia
 * auth.protect() por isClerkConfigured() DENTRO do callback do clerkMiddleware — que
 * segue na forma canonica no export default (Edge-safe; o que quebrava o bundle Edge
 * era o TERNARIO no export default, nao um `if` no callback). Com Clerk em branco,
 * /admin NAO redireciona mais p/ /entrar; em producao (chaves reais) protect() roda
 * normal e a rota fica protegida — espelhando o fail-closed de requireAdmin/layout.
 * Por isso os 3 testes de rota passam (sem afrouxar a seguranca de producao).
 *
 * Seletores RESILIENTES: <h1> por role/nome, nunca classes CSS frageis.
 *
 * PADRAO DB-FIRST do harness: cada spec recebe um banco efemero recem-seedado e
 * assertaa estado conectando via `pg` usando process.env.DATABASE_URL (exposto
 * pelo runner). Nao ha servidor/banco persistente entre runs — cada run e isolado.
 * As specs de feature (estoque/pedido) seguem este padrao: agir via lib/data ou SQL
 * e conferir colunas/CHECKs/audit_log no MESMO banco.
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

// Mock-first via HTTP (ver cabecalho): proxy.ts gateia auth.protect() por
// isClerkConfigured(), entao com Clerk em branco /admin abre e renderiza o heading.
// Se o gate/middleware redirecionasse p/ /entrar, NAO veriamos o <h1> de admin.

test("/admin/produtos renderiza a lista (mock-first, sem login)", async ({ page }) => {
  await page.goto("/admin/produtos");
  await expect(page).toHaveURL(/\/admin\/produtos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Produtos" })).toBeVisible();
});

test("/admin/pedidos renderiza a lista (mock-first, sem login)", async ({ page }) => {
  await page.goto("/admin/pedidos");
  await expect(page).toHaveURL(/\/admin\/pedidos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Pedidos" })).toBeVisible();
});

test("/admin/cupons renderiza a lista (mock-first, sem login)", async ({ page }) => {
  await page.goto("/admin/cupons");
  await expect(page).toHaveURL(/\/admin\/cupons$/);
  await expect(page.getByRole("heading", { level: 1, name: "Cupons" })).toBeVisible();
});

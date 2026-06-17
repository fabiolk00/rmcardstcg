import { test, expect } from "@playwright/test";

/**
 * E2E da storefront PUBLICA (mock-first, sem Clerk). Os dados vem do seed
 * (prisma/seed.ts) num Postgres efemero — ver scripts/e2e-with-ephemeral-pg.ts.
 *
 * Fatos do seed usados nas asserts (prisma/seed-data.ts):
 *  - 28 produtos, 27 ativos (1 inativo: "Booster Pack — Lost Origin").
 *  - Catalogo pagina de 12 em 12 (ColecoesView PER_PAGE=12).
 *  - "Charizard" casa 2 produtos ativos (Tin Collection ex / Single VMAX Rainbow).
 *
 * So testamos rotas publicas: /admin, /minhas-compras e /checkout exigem login.
 * A pagina /produto/[slug] ainda e placeholder (renderiza o slug).
 */

// Diagnostico: erros de runtime do cliente (ex.: falha de hidratacao) aparecem no
// log do Playwright, em vez de virarem so um timeout opaco de "elemento nao achado".
test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error][${testInfo.title}] ${m.text()}`);
  });
});

test("home renderiza o hero e a grade de produtos em destaque", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Sua coleção começa/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nossos produtos." })).toBeVisible();

  // featured = ativos com estoque>0, slice(0,8). Com o seed atual => 8 cards.
  const cards = page.locator("article");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBe(8);
});

test("menu leva da home para Coleções e o catálogo carrega do banco", async ({ page }) => {
  await page.goto("/");

  await page.locator("header").getByRole("link", { name: "Coleções" }).click();

  await expect(page).toHaveURL(/\/colecoes(\?.*)?$/);
  await expect(page.getByRole("heading", { name: /Todas as cartas e produtos/i })).toBeVisible();
  // Prova que o seed (27 ativos) foi lido pelo server.
  await expect(page.getByText(/Mostrando\s+27\s+produtos/)).toBeVisible();
  // Pagina 1 mostra exatamente PER_PAGE (12) cards.
  expect(await page.locator("article").count()).toBe(12);
});

test("busca filtra o catálogo por nome", async ({ page }) => {
  await page.goto("/colecoes");
  await expect(page.locator("article").first()).toBeVisible();

  await page.getByLabel("Buscar produtos").fill("Charizard");

  // Só os 2 produtos com "Charizard" no nome permanecem. Cada card tem 2 links com
  // o mesmo nome acessivel (imagem + titulo), entao desambiguamos com .first().
  await expect(
    page.getByRole("link", { name: "Tin Collection — Charizard ex" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Single — Charizard VMAX Rainbow" }).first(),
  ).toBeVisible();
  await expect.poll(() => page.locator("article").count()).toBe(2);
  // Produto não relacionado some.
  await expect(page.getByRole("link", { name: "Booster Box — Scarlet Tempest" })).toHaveCount(0);
});

test("deep-link de produto abre a página pelo slug", async ({ page }) => {
  await page.goto("/produto/booster-box-scarlet-tempest");

  await expect(page.getByRole("heading", { name: "Produto" })).toBeVisible();
  await expect(page.getByText("booster-box-scarlet-tempest")).toBeVisible();
});

test("adicionar ao carrinho coloca o produto no carrinho", async ({ page }) => {
  await page.goto("/colecoes");

  const addBtn = page.getByRole("button", { name: /^Adicionar .+ ao carrinho$/ }).first();
  await expect(addBtn).toBeVisible();
  const label = (await addBtn.getAttribute("aria-label")) ?? "";
  const name = label.replace(/^Adicionar /, "").replace(/ ao carrinho$/, "");
  expect(name.length).toBeGreaterThan(0);

  await addBtn.click();
  await page.goto("/carrinho");

  // Sai do estado vazio e mostra o item adicionado. (A linha do carrinho tem 2 links
  // com o mesmo nome — miniatura + titulo —, dai o .first().)
  await expect(page.getByText("Seu carrinho está vazio.")).toHaveCount(0);
  await expect(page.getByRole("link", { name }).first()).toBeVisible();
});

test("carrinho vazio mostra o estado vazio", async ({ page }) => {
  await page.goto("/carrinho");

  await expect(page.getByText("Seu carrinho está vazio.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver coleção" })).toBeVisible();
});

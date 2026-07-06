import { test, expect } from "@playwright/test";

/**
 * E2E da home editorial (handoff "Landing Ideias"): valida as faixas NOVAS do
 * layout — índice de categorias + manifesto — mantendo NOSSAS funcionalidades
 * (header próprio + filtro real de /colecoes). Só rotas públicas (mock-first).
 * O hero e a grade de destaque já têm cobertura em storefront.spec.ts.
 */
test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
});

test("home mostra o índice de categorias e o manifesto sobre o nosso header", async ({ page }) => {
  await page.goto("/");

  // NOSSO header foi preservado (Topbar), não o do handoff: o link "Coleções"
  // do nav próprio continua presente.
  await expect(page.locator("header").getByRole("link", { name: "Coleções" })).toBeVisible();

  // Faixa nova: índice editorial de categorias.
  await expect(page.getByRole("heading", { name: "Navegue por categoria." })).toBeVisible();
  const categorias = page.getByRole("region", { name: "Navegue por categoria." });
  for (const label of ["Booster Boxes", "Elite Trainer Boxes", "Cartas avulsas", "Acessórios"]) {
    await expect(categorias.getByRole("link", { name: new RegExp(label) })).toBeVisible();
  }

  // Faixa nova: manifesto em tinta.
  await expect(
    page.getByRole("heading", { name: "Toda carta sai lacrada, conferida e rastreada." }),
  ).toBeVisible();
});

test("card de categoria leva ao catálogo filtrado (?cat=) — funcionalidade preservada", async ({
  page,
}) => {
  await page.goto("/");

  const categorias = page.getByRole("region", { name: "Navegue por categoria." });
  const booster = categorias.getByRole("link", { name: /Booster Boxes/ });

  // O link aponta para a categoria REAL do catálogo (mesma convenção do Footer).
  await expect(booster).toHaveAttribute("href", "/colecoes?cat=Booster%20Box");

  await booster.click();

  // Navega para o catálogo já filtrado e ele carrega do banco (não é link morto).
  await expect(page).toHaveURL(/\/colecoes\?cat=Booster(%20|\s)Box/);
  await expect(page.getByRole("heading", { name: /Todas as cartas e produtos/i })).toBeVisible();
  await expect(page.locator("article").first()).toBeVisible();
});

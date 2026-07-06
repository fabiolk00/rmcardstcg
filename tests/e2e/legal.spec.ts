import { test, expect } from "@playwright/test";

/**
 * E2E das paginas legais (Politica de Privacidade / Termos de Uso) e dos links do
 * rodape que levam ate elas. Rotas publicas e ESTATICAS — nao dependem do seed/DB,
 * mas o rodape aparece em toda pagina da vitrine, entao navegamos a partir da home.
 */

test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
});

test("rodapé leva à Política de Privacidade", async ({ page }) => {
  await page.goto("/");

  await page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Política de privacidade" })
    .click();

  await expect(page).toHaveURL(/\/politica-de-privacidade$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Política de Privacidade" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "1. Introdução" })).toBeVisible();
});

test("rodapé leva aos Termos de Uso", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("contentinfo").getByRole("link", { name: "Termos de uso" }).click();

  await expect(page).toHaveURL(/\/termos-de-uso$/);
  await expect(page.getByRole("heading", { level: 1, name: "Termos de Uso" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "1. Aceitação dos Termos" })).toBeVisible();
});

test("acesso direto às rotas legais renderiza o conteúdo", async ({ page }) => {
  await page.goto("/politica-de-privacidade");
  await expect(
    page.getByRole("heading", { level: 1, name: "Política de Privacidade" }),
  ).toBeVisible();
  await expect(page.getByText(/Lei nº 13\.709\/2018/)).toBeVisible();

  await page.goto("/termos-de-uso");
  await expect(page.getByRole("heading", { level: 1, name: "Termos de Uso" })).toBeVisible();
  await expect(page.getByText(/Foro da Comarca de Curitiba/)).toBeVisible();
});

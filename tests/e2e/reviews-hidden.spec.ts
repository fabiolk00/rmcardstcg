import { test, expect } from "@playwright/test";

/**
 * E2E: com NEXT_PUBLIC_REVIEWS_ENABLED off (default), a UI de avaliacoes some da
 * vitrine SEM quebrar layout. So rotas publicas (mock-first). O slug e o mesmo produto
 * do seed usado no storefront.spec (prisma/seed-data.ts).
 */
test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
});

test("página de produto renderiza sem a seção de avaliações (sem buraco)", async ({ page }) => {
  await page.goto("/produto/booster-box-scarlet-tempest");

  // Conteudo essencial permanece (nome + botao de compra) — nada de layout break.
  await expect(page.getByRole("heading", { name: "Booster Box — Scarlet Tempest" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Adicionar Booster Box — Scarlet Tempest ao carrinho" }),
  ).toBeVisible();

  // Nenhuma superficie de avaliacoes: a section #avaliacoes some e nenhum "avaliaç..."
  // aparece (nem no ProductInfo, nem nos cards de relacionados).
  await expect(page.locator("#avaliacoes")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Avaliações" })).toHaveCount(0);
  await expect(page.getByText(/avaliaç(ão|ões)/i)).toHaveCount(0);
});

test('coleções não oferece o sort "Melhor avaliados" nem nota nos cards', async ({ page }) => {
  await page.goto("/colecoes");
  await expect(page.locator("article").first()).toBeVisible();

  // Opcao de ordenacao por nota some do dropdown quando a flag esta off.
  await expect(page.getByRole("option", { name: "Melhor avaliados" })).toHaveCount(0);
  // Cards sem "· N avaliações".
  await expect(page.getByText(/\d+\s+avaliações/i)).toHaveCount(0);
});

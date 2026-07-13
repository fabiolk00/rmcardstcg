import { test, expect, type Page } from "@playwright/test";

/**
 * E2E do PAINEL DO CLIENTE (mock-first, sem Clerk => guest navega o painel;
 * dados do seed no Postgres efemero — ver scripts/e2e-with-ephemeral-pg.ts).
 *
 * Fatos do seed usados nas asserts (prisma/seed-data.ts):
 *  - "Single — Pikachu Illustrator Reprint": ativo, stock 2 (reserved nasce 0)
 *    => 3o clique em "Compre agora" tem que recusar (produto indisponivel).
 *  - "Coleção Premium — Mewtwo VSTAR": stock 0 => card "Esgotado" (sem botao).
 *
 * Cobre: redirect /painel -> pedidos, shell (sidebar/topbar), regra do RAIL
 * (todas as telas MENOS carrinho e conta), toast de adicionado/indisponivel,
 * dropdown do perfil com "Conta" (sem "Configurações") e o checkout do painel.
 */

test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error][${testInfo.title}] ${m.text()}`);
  });
});

const rail = (page: Page) => page.getByRole("complementary", { name: "Resumo do carrinho" });

/** Busca um produto nas colecoes do painel e espera o card aparecer. */
async function searchInColecoes(page: Page, term: string) {
  await page.goto("/painel/colecoes");
  await page.getByPlaceholder("Buscar por nome ou categoria…").fill(term);
  await expect(page.locator("article").first()).toBeVisible();
}

test("/painel redireciona para Meus Pedidos e monta o shell com sidebar", async ({ page }) => {
  await page.goto("/painel");

  await expect(page).toHaveURL(/\/painel\/pedidos$/);
  await expect(page.getByText("Painel do cliente")).toBeVisible();

  // Sidebar com os 4 itens do cliente (nav propria, molde do admin).
  const nav = page.getByRole("navigation", { name: "Menu do painel" });
  for (const item of ["Conta", "Coleções", "Meus Pedidos", "Carrinho"]) {
    await expect(nav.getByRole("link", { name: item })).toBeVisible();
  }

  // Guest (mock-first) nao tem pedidos: estado vazio com CTA para colecoes.
  await expect(page.getByText("Você ainda não tem compras.")).toBeVisible();
});

test("rail do carrinho aparece em pedidos/colecoes e SOME em carrinho/conta/checkout", async ({
  page,
}) => {
  await page.goto("/painel/pedidos");
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).getByText("Seu carrinho está vazio.")).toBeVisible();

  await page.goto("/painel/colecoes");
  await expect(rail(page)).toBeVisible();

  // Regra: NAO aparece na tela de carrinho (redundante) nem na de conta.
  await page.goto("/painel/carrinho");
  await expect(page.getByRole("heading", { name: "Carrinho" })).toBeVisible();
  await expect(rail(page)).toHaveCount(0);

  await page.goto("/painel/conta");
  await expect(rail(page)).toHaveCount(0);

  // No checkout o Resumo do CheckoutView ja cobre — rail some para nao duplicar.
  await page.goto("/painel/checkout");
  await expect(page.getByRole("heading", { name: "Finalizar compra" })).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
});

test("Compre agora: toast de adicionado, rail atualiza e estoque no limite recusa", async ({
  page,
}) => {
  // Pikachu Illustrator: stock 2 no seed — o cenario inteiro numa sessao
  // (mesmo localStorage): 2 adds OK, 3o recusa sem mudar o carrinho.
  await searchInColecoes(page, "Pikachu Illustrator");
  const addButton = page.getByRole("button", {
    name: /Adicionar Single — Pikachu Illustrator Reprint ao carrinho/,
  });

  // Espera a HIDRATACAO antes de clicar (o rail sai de "Carregando…" para o
  // estado vazio SO quando o client montou — clique pre-hidratacao se perde).
  await expect(rail(page).getByText("Seu carrinho está vazio.")).toBeVisible();

  // 1o clique: toast de ADICIONADO (mensagem existente) + rail com o item.
  await addButton.click();
  const toast = page.getByRole("status");
  await expect(toast).toContainText("adicionado ao carrinho");
  await expect(toast).toContainText("Pikachu Illustrator");
  await expect(rail(page).getByText("Single — Pikachu Illustrator Reprint")).toBeVisible();
  await expect(rail(page).getByText("1×")).toBeVisible();

  // 2o clique: ainda ha estoque (2) => adicionado de novo, qty 2 no rail.
  await addButton.click();
  await expect(rail(page).getByText("2×")).toBeVisible();

  // 3o clique: carrinho ja tem TODO o estoque => "produto indisponível" e a
  // quantidade NAO muda (nada adicionado).
  await addButton.click();
  await expect(page.getByRole("status")).toContainText("produto indisponível");
  await expect(rail(page).getByText("2×")).toBeVisible();

  // O rail leva ao checkout do painel (fluxo de compra dentro do dashboard).
  await rail(page).getByRole("link", { name: "Finalizar compra" }).click();
  await expect(page).toHaveURL(/\/painel\/checkout$/);
  await expect(page.getByRole("heading", { name: "Finalizar compra" })).toBeVisible();
});

test("produto esgotado no catálogo do painel: card 'Esgotado', sem botão de compra", async ({
  page,
}) => {
  await searchInColecoes(page, "Mewtwo VSTAR");
  const card = page.locator("article", { hasText: "Coleção Premium — Mewtwo VSTAR" });
  await expect(card.getByText("Esgotado")).toBeVisible();
  await expect(card.getByRole("button", { name: /Adicionar .* ao carrinho/ })).toHaveCount(0);
});

test("dropdown do perfil: 'Conta' no lugar de 'Configurações' e navega para /painel/conta", async ({
  page,
}) => {
  await page.goto("/painel/pedidos");

  // Mock-first renderiza o card de perfil com o email placeholder do cliente.
  await page.getByRole("button", { name: /cliente@rmcards\.com\.br/ }).click();

  const menu = page.getByRole("menu", { name: "Menu do perfil" });
  await expect(menu.getByRole("menuitem", { name: "Conta" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Configurações" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Coleções" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Sair" })).toBeVisible();

  await menu.getByRole("menuitem", { name: "Conta" }).click();
  await expect(page).toHaveURL(/\/painel\/conta$/);
  // exact: o h2 "Dados de contato" tambem casa com /Conta/i (strict mode).
  await expect(page.getByRole("heading", { name: "Conta", exact: true })).toBeVisible();
});

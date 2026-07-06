import { test, expect } from "@playwright/test";

/**
 * E2E: consentimento LGPD no checkout (mock-first, guest). Coloca um item no carrinho,
 * abre o checkout e valida o checkbox obrigatorio + os links para as paginas legais
 * REAIS (/termos-de-uso e /politica-de-privacidade). O bloqueio do submit sem aceite
 * e coberto por unit/source-scan (onSubmit + re-validacao no server).
 */
test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error][${testInfo.title}] ${m.text()}`);
  });
});

test("checkout exige aceite dos termos, com links para as páginas legais", async ({ page }) => {
  // Coloca um produto no carrinho (mesma tecnica do storefront.spec: verifica o
  // efeito client-side no localStorage com retry, robusto sob hidratacao tardia).
  await page.goto("/colecoes");
  const addBtn = page.getByRole("button", { name: /^Adicionar .+ ao carrinho$/ }).first();
  await expect(addBtn).toBeVisible();
  const label = (await addBtn.getAttribute("aria-label")) ?? "";
  const name = label.replace(/^Adicionar /, "").replace(/ ao carrinho$/, "");
  await expect(async () => {
    await addBtn.click();
    const raw = await page.evaluate(() => localStorage.getItem("rmcards.cart.v1"));
    expect(raw ?? "").toContain(name);
  }).toPass({ timeout: 15_000 });

  await page.goto("/checkout");

  // Escopo no formulario de checkout — o rodape tambem linka as paginas legais com o
  // mesmo texto (fora do <form>), entao restringimos as buscas ao form p/ nao casar 2.
  const form = page.locator("form");

  // Checkbox de consentimento presente e DESMARCADO por default (aceite ativo).
  const consent = form.getByRole("checkbox", {
    name: "Aceito os Termos de uso e a Política de privacidade",
  });
  await expect(consent).toBeVisible();
  await expect(consent).not.toBeChecked();

  // Links legais reais deste repo, abrindo em nova aba.
  await expect(form.getByRole("link", { name: "Termos de uso" })).toHaveAttribute(
    "href",
    "/termos-de-uso",
  );
  await expect(form.getByRole("link", { name: "Política de privacidade" })).toHaveAttribute(
    "href",
    "/politica-de-privacidade",
  );

  // Marcar o aceite funciona.
  await consent.check();
  await expect(consent).toBeChecked();
});

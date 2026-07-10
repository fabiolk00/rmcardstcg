import { test, expect } from "@playwright/test";

/**
 * E2E: seletor de forma de pagamento no checkout (mock-first, guest). Coloca um item
 * no carrinho, abre o checkout e valida o radiogroup PIX / Cartao de credito: PIX vem
 * selecionado por default (retrocompativel) e alternar p/ Cartao troca a selecao. A
 * cobranca real (PIX QR vs fatura) depende do Asaas e e coberta por unit/manual.
 */
test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console.error][${testInfo.title}] ${m.text()}`);
  });
});

test("checkout oferece PIX e Cartão; PIX é o padrão e a troca funciona", async ({ page }) => {
  // Coloca um produto no carrinho (mesma tecnica do checkout-consent.spec).
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

  const group = page.getByRole("radiogroup", { name: "Forma de pagamento" });
  await expect(group).toBeVisible();

  const pix = group.getByRole("radio", { name: /PIX/ });
  const card = group.getByRole("radio", { name: /Cartão de crédito/ });

  // PIX é o padrão (preserva o comportamento anterior, PIX-only).
  await expect(pix).toBeChecked();
  await expect(card).not.toBeChecked();

  // Alternar para cartão troca a seleção.
  await card.check();
  await expect(card).toBeChecked();
  await expect(pix).not.toBeChecked();

  // E voltar para PIX também.
  await pix.check();
  await expect(pix).toBeChecked();
  await expect(card).not.toBeChecked();
});

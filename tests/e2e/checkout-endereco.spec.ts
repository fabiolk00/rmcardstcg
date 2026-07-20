import { test, expect } from "@playwright/test";

/**
 * E2E: o endereco de entrega passou a ter NUMERO e BAIRRO em campos proprios —
 * a transportadora exige os dois separados para emitir a etiqueta, e antes tudo
 * ia amontoado em "rua". Cobre o que so a UI prova: os campos existem e o submit
 * trava sem eles (a validacao de servidor tem teste unitario proprio).
 *
 * Mock-first/guest, como os demais specs de checkout.
 */
test.beforeEach(async ({ page }, testInfo) => {
  page.on("pageerror", (e) => console.log(`[pageerror][${testInfo.title}] ${e.message}`));
});

async function addItemAndOpenCheckout(page: import("@playwright/test").Page) {
  await page.goto("/colecoes");
  const addBtn = page.getByRole("button", { name: /^Adicionar .+ ao carrinho$/ }).first();
  await expect(addBtn).toBeVisible();
  const label = (await addBtn.getAttribute("aria-label")) ?? "";
  const name = label.replace(/^Adicionar /, "").replace(/ ao carrinho$/, "");
  // Mesma tecnica dos outros specs: valida o efeito no localStorage com retry,
  // robusto sob hidratacao tardia.
  await expect(async () => {
    await addBtn.click();
    const raw = await page.evaluate(() => localStorage.getItem("rmcards.cart.v1"));
    expect(raw ?? "").toContain(name);
  }).toPass({ timeout: 15_000 });
  await page.goto("/checkout");
}

test("endereço de entrega tem campos próprios de número, bairro e complemento", async ({
  page,
}) => {
  await addItemAndOpenCheckout(page);
  const form = page.locator("form");

  await expect(form.getByText("Rua / avenida", { exact: true })).toBeVisible();
  await expect(form.getByText("Número", { exact: true })).toBeVisible();
  await expect(form.getByText("Bairro", { exact: true })).toBeVisible();
  await expect(form.getByText("Complemento (opcional)", { exact: true })).toBeVisible();
});

test("submit sem o número do endereço é bloqueado com mensagem específica", async ({ page }) => {
  await addItemAndOpenCheckout(page);
  const form = page.locator("form");

  const fill = async (label: string, value: string) => {
    await form.locator("label", { hasText: label }).locator("input").first().fill(value);
  };

  // Tudo preenchido MENOS o numero (o bairro entra para provar que a mensagem
  // aponta o campo certo, e nao o primeiro vazio qualquer).
  await fill("Nome completo", "Maria Colecionadora");
  await fill("E-mail", "maria@exemplo.com");
  await fill("Telefone", "(41) 99999-0000");
  await fill("CPF/CNPJ", "529.982.247-25");
  await fill("CEP", "80010-000");
  await fill("Cidade", "Curitiba");
  await fill("Rua / avenida", "Rua XV de Novembro");
  await fill("Bairro", "Centro");
  await form.locator("select").first().selectOption("PR");

  // O botao de pagar so habilita depois de cotar o frete e aceitar os termos —
  // por isso o teste passa por esses dois passos antes de provar a validacao.
  // "Calcular frete" vive no RESUMO (aside), fora do <form>.
  await page.getByRole("button", { name: "Calcular frete" }).click();
  await form
    .getByRole("checkbox", { name: "Aceito os Termos de uso e a Política de privacidade" })
    .check();

  const pay = form.getByRole("button", { name: /^Pagar/ });
  await expect(pay).toBeEnabled({ timeout: 15_000 });
  await pay.click();

  await expect(form.getByText("Informe o número.")).toBeVisible();
});

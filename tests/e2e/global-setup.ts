import { chromium, type FullConfig } from "@playwright/test";

/**
 * Aquecimento das rotas no `next dev`.
 *
 * O `next dev` compila cada rota (server + os chunks de hidratacao do cliente) SOB
 * DEMANDA, no primeiro acesso. Com a suite em paralelo, varios testes batem a frio
 * ao mesmo tempo e os que dependem de hidratacao (busca no catalogo, carrinho)
 * estouram o timeout esperando o JS do cliente chegar.
 *
 * Aqui visitamos cada rota UMA vez num browser real, esperando `networkidle` (os
 * chunks do cliente baixarem). Isso popula o cache do dev; quando a suite roda, as
 * rotas ja estao quentes e hidratam na hora. Roda depois do webServer subir.
 */
async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const routes = ["/", "/colecoes", "/produto/booster-box-scarlet-tempest", "/carrinho"];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const route of routes) {
      await page.goto(new URL(route, baseURL).toString(), {
        waitUntil: "networkidle",
        timeout: 120_000,
      });
    }
  } finally {
    await browser.close();
  }
}

export default globalSetup;

import { defineConfig, devices } from "@playwright/test";

/**
 * Config E2E (Playwright) da storefront publica.
 *
 * O servidor sobe via `webServer` em modo MOCK-FIRST e apontado para um Postgres
 * EFEMERO — o orquestrador `scripts/e2e-with-ephemeral-pg.ts` (rodado por
 * `pnpm test:e2e`) sobe o banco, materializa o schema, faz o seed e exporta
 * DATABASE_URL/DIRECT_URL no process.env antes de invocar o Playwright.
 *
 * Seguranca: a chave Clerk do .env e `pk_live` (travada no dominio de producao,
 * quebraria no localhost). Aqui as chaves Clerk vao em BRANCO para forcar o
 * caminho mock-first (isClerkConfigured()=false -> sem ClerkProvider). O @next/env
 * NAO sobrescreve uma var ja presente no process.env, entao DATABASE_URL efemero e
 * as chaves vazias VENCEM o .env — o server nunca toca o Supabase de producao.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // Aquece as rotas (server + chunks de hidratacao do cliente) antes da suite.
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `next dev` (nao `next start`): a middleware Clerk e incondicional e exige
    // publishableKey em producao; so o dev tem o fallback keyless que permite o
    // modo mock-first. O globalSetup aquece os chunks de hidratacao antes da suite.
    command: `pnpm exec next dev --port ${PORT}`,
    url: BASE_URL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // Banco efemero exportado pelo orquestrador (vence o .env via @next/env).
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
      // Forca mock-first: sem Clerk no localhost (a chave do .env e pk_live).
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      CLERK_SECRET_KEY: "",
    },
  },
});

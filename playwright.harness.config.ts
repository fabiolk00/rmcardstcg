import { defineConfig, devices } from "@playwright/test";

/**
 * Config do HARNESS de admin (Playwright). Espelha playwright.config.ts em
 * espirito (mock-first, Postgres efemero), mas serve as specs de admin sob
 * `tests/harness/` numa porta propria para nao colidir com o E2E publico.
 *
 * DIFERENCAS para o playwright.config.ts:
 *  - testDir = "./tests/harness" (specs de operacao manual de admin).
 *  - porta propria via E2E_PORT (default 3200), separada do E2E publico (3100).
 *  - webServer roda `next dev`, NAO `next start`. Critico: o gate de /admin em
 *    app/admin/layout.tsx so libera mock-first quando NODE_ENV != "production".
 *    `next start` roda em producao (fail-closed: redirect "/"); `next dev` roda
 *    em desenvolvimento (mock-first ABERTO). O harness precisa de /admin aberto.
 *
 * Seguranca: as chaves Clerk vao em BRANCO (process.env), forcando o caminho
 * mock-first (isClerkConfigured()=false). DATABASE_URL/DIRECT_URL sao herdados
 * do process.env (exportados por scripts/harness-with-ephemeral-pg.ts antes de
 * invocar o Playwright). O @next/env nao sobrescreve env ja presente, entao o
 * banco efemero e as chaves vazias vencem o .env de producao.
 *
 * ISOLAMENTO: cada RUN do harness recebe um Postgres efemero recem-seedado e
 * unico (uma porta aleatoria). Nao ha servidor/banco persistente entre runs;
 * cada `pnpm harness <spec>` e um run isolado. As specs DEVEM assertar estado
 * de DB conectando via `pg`/Prisma com process.env.DATABASE_URL (ver os specs).
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/harness",
  // As specs de harness mutam o MESMO banco efemero (estoque, pedidos, cupons).
  // Serial evita corridas de estado entre arquivos no mesmo run.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `next dev` (NAO `next start`): mantem NODE_ENV=development, o unico modo em
    // que app/admin/layout.tsx libera /admin sem Clerk (mock-first). `next start`
    // roda em producao e o gate fail-closed redireciona para "/".
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

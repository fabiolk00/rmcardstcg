/**
 * Orquestrador LOCAL do E2E: sobe um Postgres efemero, materializa o schema, faz
 * o seed e roda o Playwright — tudo num comando, sem Docker e SEM tocar o banco
 * de producao.
 *
 *   pnpm test:e2e                 # toda a suite E2E
 *   pnpm test:e2e --headed        # args extras passam pro playwright
 *   pnpm test:e2e storefront      # filtra por nome de arquivo/teste
 *
 * Fluxo (espelha scripts/test-with-ephemeral-pg.ts):
 *   1. boot embedded-postgres (porta aleatoria, datadir temporario, UTC)
 *   2. DATABASE_URL/DIRECT_URL = conn string efemera (sslmode=disable)
 *   3. prisma db push (tabelas/colunas/enums/FKs do schema.prisma)
 *   4. aplica o suplemento (CHECKs + indice LOWER(code))
 *   5. seed (prisma/seed.ts) — 28 produtos / pedidos de exemplo
 *   6. playwright test — o webServer (`next dev`) herda o env e sobe mock-first
 *      apontado para o PG efemero; um globalSetup aquece as rotas antes da suite
 *      (ver playwright.config.ts / tests/e2e/global-setup.ts)
 *   7. teardown do Postgres no finally; exit code = o do Playwright
 *
 * Por que `next dev` e nao um build de producao: a middleware Clerk (proxy.ts) e
 * incondicional e EXIGE publishableKey em producao — `next start` mock-first joga
 * "Missing publishableKey". So o dev tem o fallback keyless que deixa o app rodar
 * sem chave (mock-first). A pk_live do .env e travada no dominio de producao.
 *
 * MOCK-FIRST consistente: as chaves Clerk vao em BRANCO ja AQUI (process.env). O
 * @next/env nao sobrescreve var ja presente, entao isso vence a pk_live do .env.
 */
import { spawnSync } from "node:child_process";

import { startEphemeralPostgres } from "../tests/helpers/ephemeral-pg";

async function main(): Promise<number> {
  console.log("[test:e2e] subindo Postgres efemero (embedded-postgres)...");
  const pg = await startEphemeralPostgres();
  process.env.DATABASE_URL = pg.connectionString;
  process.env.DIRECT_URL = pg.connectionString; // prisma.config.ts usa DIRECT_URL no push
  // Mock-first ANTES do build: o @next/env nao sobrescreve env ja presente, entao
  // estas chaves vazias vencem o .env (pk_live) tanto no build quanto no `next start`.
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "";
  process.env.CLERK_SECRET_KEY = "";

  const run = (cmd: string, args: string[]): number => {
    const r = spawnSync(cmd, args, {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32", // resolve .cmd no Windows (pnpm/prisma/playwright)
    });
    return r.status ?? 1;
  };

  try {
    console.log("[test:e2e] prisma db push (schema.prisma -> banco efemero)...");
    let code = run("pnpm", ["prisma", "db", "push", "--accept-data-loss"]);
    if (code !== 0) return code;

    console.log("[test:e2e] aplicando suplemento (CHECKs + LOWER(code))...");
    code = run("pnpm", ["tsx", "scripts/apply-test-constraints.ts"]);
    if (code !== 0) return code;

    console.log("[test:e2e] seed (prisma/seed.ts)...");
    code = run("pnpm", ["tsx", "prisma/seed.ts"]);
    if (code !== 0) return code;

    const passthrough = process.argv.slice(2);
    console.log(`[test:e2e] playwright test ${passthrough.join(" ")}...`);
    return run("pnpm", ["exec", "playwright", "test", ...passthrough]);
  } finally {
    console.log("[test:e2e] derrubando Postgres efemero...");
    await pg.teardown();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[test:e2e] erro:", err);
    process.exit(1);
  });

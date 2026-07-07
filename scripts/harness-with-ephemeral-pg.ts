/**
 * Orquestrador do HARNESS de admin: sobe um Postgres efemero REAL, materializa o
 * schema, faz o seed e roda o Playwright (config do harness) — tudo num comando,
 * sem Docker e SEM tocar o banco de producao.
 *
 *   pnpm harness                                   # toda a suite de harness
 *   pnpm harness tests/harness/estoque/foo.spec.ts # uma spec especifica
 *   pnpm harness --headed                          # args extras passam pro playwright
 *
 * Espelha scripts/e2e-with-ephemeral-pg.ts, com DUAS diferencas deliberadas:
 *  1. roda `playwright test --config playwright.harness.config.ts` (testDir
 *     ./tests/harness, porta 3200).
 *  2. NAO faz `next build`: o webServer do harness usa `next dev`, o unico modo
 *     em que o gate de /admin (app/admin/layout.tsx) libera mock-first sem Clerk
 *     (NODE_ENV != production). `next start`/build rodariam em producao e o gate
 *     fail-closed redirecionaria /admin para "/".
 *
 * Fluxo:
 *   1. boot embedded-postgres (porta aleatoria, datadir temporario, UTC)
 *   2. DATABASE_URL/DIRECT_URL = conn string efemera (sslmode=disable)
 *   3. prisma db push (tabelas/colunas/enums/FKs do schema.prisma)
 *   4. aplica o suplemento (CHECKs + indice LOWER(code))
 *   5. seed (prisma/seed.ts) — produtos/pedidos de exemplo
 *   6. playwright test --config playwright.harness.config.ts (webServer = next dev)
 *   7. teardown do Postgres no finally; exit code = o do Playwright
 *
 * ISOLAMENTO: cada invocacao recebe um banco NOVO e recem-seedado. Nao ha estado
 * compartilhado entre runs — cada spec de harness assertaa contra ESTE banco via
 * process.env.DATABASE_URL (pg/Prisma). Ver tests/harness/smoke.admin.spec.ts.
 *
 * MOCK-FIRST: as chaves Clerk vao em BRANCO ja AQUI (process.env), antes do dev
 * server. O @next/env nao sobrescreve env ja presente, entao estas chaves vazias
 * vencem o .env (pk_live, travada no dominio de producao).
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

import { startEphemeralPostgres } from "../tests/helpers/ephemeral-pg";

async function main(): Promise<number> {
  console.log("[harness] subindo Postgres efemero (embedded-postgres)...");
  const pg = await startEphemeralPostgres();
  process.env.DATABASE_URL = pg.connectionString;
  process.env.DIRECT_URL = pg.connectionString; // prisma.config.ts usa DIRECT_URL no push
  // Mock-first: estas chaves vazias vencem o .env (pk_live) no dev server.
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
    console.log("[harness] prisma db push (schema.prisma -> banco efemero)...");
    let code = run("pnpm", ["prisma", "db", "push", "--accept-data-loss"]);
    if (code !== 0) return code;

    console.log("[harness] aplicando suplemento (CHECKs + LOWER(code))...");
    code = run("pnpm", ["tsx", "scripts/apply-test-constraints.ts"]);
    if (code !== 0) return code;

    console.log("[harness] seed (prisma/seed.ts)...");
    code = run("pnpm", ["tsx", "prisma/seed.ts"]);
    if (code !== 0) return code;

    // Rodada interrompida (Ctrl+C / kill no meio do next dev) pode deixar o cache
    // .next corrompido — o webServer seguinte morre com "Cannot find module
    // '@clerk/nextjs'" e estoura o timeout de 120s. Limpar ANTES de subir garante
    // boot reproduzivel ao custo de um rebuild do dev (~10-20s). Nao rode o
    // harness com um `next dev` de desenvolvimento aberto: ambos usam .next.
    console.log("[harness] limpando .next (cache pode estar corrompido de run interrompido)...");
    rmSync(".next", { recursive: true, force: true });

    const passthrough = process.argv.slice(2);
    console.log(`[harness] playwright test (config harness) ${passthrough.join(" ")}...`);
    return run("pnpm", [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.harness.config.ts",
      ...passthrough,
    ]);
  } finally {
    console.log("[harness] derrubando Postgres efemero...");
    await pg.teardown();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[harness] erro:", err);
    process.exit(1);
  });

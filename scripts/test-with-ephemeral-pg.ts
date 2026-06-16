/**
 * Orquestrador LOCAL: sobe um Postgres efemero, materializa o schema, e roda os
 * testes que dependem de banco — tudo num comando, sem Docker.
 *
 *   pnpm test:db                 # roda toda a suite contra o PG efemero
 *   pnpm test:db tests/concurrency   # so um subconjunto (args passam pro vitest)
 *
 * Fluxo:
 *   1. boot embedded-postgres (porta aleatoria, datadir temporario, UTC)
 *   2. DATABASE_URL/DIRECT_URL/TEST_DATABASE_URL = conn string (sslmode=disable)
 *   3. prisma db push (tabelas/colunas/enums/FKs do schema.prisma)
 *   4. aplica prisma/test-schema-supplement.sql (CHECKs + indice LOWER(code))
 *   5. spawna `vitest run` herdando o env (os workers veem TEST_DATABASE_URL)
 *   6. teardown do Postgres no finally; exit code = o do vitest
 *
 * Por que um script e nao vitest globalSetup: o vitest roda os testes em workers
 * separados; herdar process.env de um processo-filho spawnado e deterministico,
 * enquanto a propagacao de env do globalSetup pros workers varia por pool.
 */
import { spawnSync } from "node:child_process";

import { startEphemeralPostgres } from "../tests/helpers/ephemeral-pg";

async function main(): Promise<number> {
  console.log("[test:db] subindo Postgres efemero (embedded-postgres)...");
  const pg = await startEphemeralPostgres();
  process.env.DATABASE_URL = pg.connectionString;
  process.env.DIRECT_URL = pg.connectionString; // prisma.config.ts usa DIRECT_URL no push
  process.env.TEST_DATABASE_URL = pg.connectionString; // destrava os describe.skipIf

  const run = (cmd: string, args: string[]): number => {
    const r = spawnSync(cmd, args, {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32", // resolve .cmd no Windows (pnpm/prisma/vitest)
    });
    return r.status ?? 1;
  };

  try {
    console.log("[test:db] prisma db push (schema.prisma -> banco efemero)...");
    let code = run("pnpm", ["prisma", "db", "push", "--accept-data-loss"]);
    if (code !== 0) return code;

    console.log("[test:db] aplicando suplemento (CHECKs + LOWER(code))...");
    code = run("pnpm", ["tsx", "scripts/apply-test-constraints.ts"]);
    if (code !== 0) return code;

    const passthrough = process.argv.slice(2);
    const vitestArgs = ["vitest", "run", ...passthrough];
    console.log(`[test:db] vitest ${["run", ...passthrough].join(" ")}...`);
    return run("pnpm", vitestArgs);
  } finally {
    console.log("[test:db] derrubando Postgres efemero...");
    await pg.teardown();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[test:db] erro:", err);
    process.exit(1);
  });

/**
 * Postgres efemero para os testes que precisam de banco (describe.skipIf(
 * !TEST_DATABASE_URL)). Usa embedded-postgres: binarios REAIS do Postgres rodando
 * numa porta TCP — fala o wire protocol, entao casa com @prisma/adapter-pg (pg).
 *
 * Por que Postgres real e nao pg-mem/pglite: as suites de concorrencia exercitam
 * locks reais (FOR UPDATE, CAS por row, transacoes) — fidelidade importa.
 *
 * Efemero: cluster novo num diretorio temporario, descartado no teardown.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";

export interface EphemeralPg {
  /** Connection string ja com sslmode=disable (o PG local nao tem TLS). */
  connectionString: string;
  /** Para o servidor e remove o diretorio de dados. Idempotente. */
  teardown: () => Promise<void>;
}

/** Porta efemera alta, evita colisao com um Postgres local na 5432. */
function randomPort(): number {
  return 49152 + Math.floor(Math.random() * 15000);
}

/**
 * Carrega embedded-postgres SOB DEMANDA. E uma optionalDependency: so faz falta
 * para `pnpm test:db`. O especificador em variavel (`: string`) impede o tsc de
 * resolver o modulo, entao build/typecheck e installs com --no-optional (Vercel/CI)
 * nao dependem dele. Erro claro se ausente.
 */
async function loadEmbeddedPostgres(): Promise<any> {
  const pkg: string = "embedded-postgres";
  try {
    return (await import(pkg)).default;
  } catch {
    throw new Error(
      "[test:db] 'embedded-postgres' nao instalado (optionalDependency). Rode " +
        "`pnpm add -DO embedded-postgres@18.4.0-beta.17` para o runner local, ou " +
        "defina TEST_DATABASE_URL apontando para um Postgres acessivel.",
    );
  }
}

export async function startEphemeralPostgres(): Promise<EphemeralPg> {
  const port = randomPort();
  const user = "postgres";
  const password = "postgres";
  const database = "rmcards_test";
  // databaseDir curto, sem espacos/acentos (evita pegadinhas do initdb no Windows).
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "rmc-pg-"));

  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    authMethod: "scram-sha-256",
    persistent: false,
    initdbFlags: ["--encoding=UTF8"],
    onError: (e: unknown) => {
      console.error("[embedded-postgres]", e);
    },
  });

  await pg.initialise(); // roda initdb (gargalo ~segundos na 1a vez)
  await pg.start();
  await pg.createDatabase(database);

  const connectionString = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;

  // FIDELIDADE COM PRODUCAO: o Supabase roda em UTC e o app grava instantes UTC.
  // embedded-postgres herda o fuso da maquina (ex.: America/Sao_Paulo), o que
  // desloca comparacoes timestamptz<->timestamp (ex.: expire_overdue_orders usa
  // `due_date < now() - interval '60 min'`). Forcar UTC reproduz o comportamento
  // de producao. Vale para todas as sessoes futuras (db push + os testes).
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`ALTER DATABASE "${database}" SET timezone TO 'UTC'`);
  await admin.end();

  let stopped = false;
  const teardown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await pg.stop();
    } finally {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows as vezes segura o handle por um instante; ignore no teardown.
      }
    }
  };

  return { connectionString, teardown };
}

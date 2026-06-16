/**
 * Aplica prisma/test-schema-supplement.sql (CHECK constraints + indice funcional
 * LOWER(code) que `prisma db push` NAO gera) num Postgres de teste JA com as
 * tabelas criadas pelo push. Idempotente (o SQL usa DROP ... IF EXISTS).
 *
 * Le a conexao de DIRECT_URL (o datasource das migrations em prisma.config.ts) ou
 * DATABASE_URL. Postgres local sem TLS — nenhuma opcao ssl (o pg so negocia TLS se
 * `ssl` for passado).
 *
 * Uso: tsx scripts/apply-test-constraints.ts   (com DIRECT_URL/DATABASE_URL no env)
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error("[db:test:setup] DIRECT_URL/DATABASE_URL nao definida.");
}

const sqlPath = path.join(process.cwd(), "prisma", "test-schema-supplement.sql");
const sql = readFileSync(sqlPath, "utf8");

async function main(): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // node-postgres executa multiplos statements num unico query() (simple query).
    // O arquivo e idempotente, entao roda inteiro de uma vez.
    await client.query(sql);
    console.log("[db:test:setup] suplemento de schema aplicado (CHECKs + LOWER(code)).");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[db:test:setup] falha ao aplicar o suplemento:", err);
  process.exit(1);
});

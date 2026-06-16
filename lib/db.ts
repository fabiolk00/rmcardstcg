import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client";

/**
 * Cliente Prisma (singleton) — conexao com o Postgres do Supabase.
 *
 * Prisma 7 conecta via driver adapter. O @prisma/adapter-pg usa node-postgres e,
 * por padrao, NAO cacheia prepared statements — logo e seguro usar o pooler em
 * transaction-mode (DATABASE_URL, porta 6543/pgbouncer). As migrations usam a
 * conexao direta (DIRECT_URL), configurada em prisma.config.ts.
 *
 * Singleton via globalThis: o hot-reload do Next em dev recria modulos, e sem
 * isso abririamos um Pool novo a cada reload.
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL nao definida — confira o .env.");
}

/**
 * Decide a opcao `ssl` do adapter a partir da connection string.
 *
 * - Postgres LOCAL / sem TLS (`sslmode=disable`, ou host localhost/127.0.0.1/[::1],
 *   ex.: banco de teste efemero): conecta SEM ssl. Sem isso o node-postgres tenta
 *   TLS e o servidor local responde "server does not support SSL connections".
 * - Qualquer outro host (Supabase em PRODUCAO): mantem `ssl:{rejectUnauthorized:false}`
 *   — Supabase exige TLS e o relax evita erro de cadeia de cert. A URL do pooler do
 *   Supabase nao casa nenhuma condicao abaixo, entao PRODUCAO fica inalterada.
 */
function resolveSsl(url: string): false | { rejectUnauthorized: false } {
  if (url.toLowerCase().includes("sslmode=disable")) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, ""); // tira [] de IPv6
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  } catch {
    // URL nao-parseavel: mantem TLS (fail-safe p/ producao).
  }
  return { rejectUnauthorized: false };
}

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString,
    // Local/sem-TLS => sem ssl; Supabase => rejectUnauthorized:false (ver resolveSsl).
    ssl: resolveSsl(connectionString as string),
  });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

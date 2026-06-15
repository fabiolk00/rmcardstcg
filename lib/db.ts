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

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString,
    // Supabase exige TLS; rejectUnauthorized:false evita erro de cadeia de cert.
    ssl: { rejectUnauthorized: false },
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

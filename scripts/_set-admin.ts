/**
 * One-off: promove uma conta a role=admin DIRETO no banco (fonte de verdade do
 * guard quando a linha existe). Uso:
 *   pnpm tsx scripts/_set-admin.ts <email>
 * ex.: pnpm tsx scripts/_set-admin.ts fabito.kroker@gmail.com
 * Sem argumento, usa o e-mail padrao abaixo. Idempotente. Apagar depois.
 */
export {};
for (const file of [".env.local", ".env"]) {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(file);
  } catch {}
}

const EMAIL = (process.argv[2] ?? "fabito.kroker@gmail.com").trim().toLowerCase();

async function main() {
  const { prisma } = await import("../lib/db");
  console.log("DB host   :", new URL(process.env.DATABASE_URL as string).hostname);
  console.log("alvo      :", EMAIL);

  const before = await prisma.user.findMany({
    where: { email: { equals: EMAIL, mode: "insensitive" }, deletedAt: null },
    select: { clerkUserId: true, email: true, role: true },
  });
  console.log("antes     :", before.length ? before : "NENHUMA LINHA COM ESSE E-MAIL");
  if (!before.length) {
    console.log(">> Sem linha no banco pra esse e-mail. Rode o backfill antes, ou confira o e-mail.");
    await prisma.$disconnect();
    return;
  }

  const res = await prisma.user.updateMany({
    where: { email: { equals: EMAIL, mode: "insensitive" }, deletedAt: null },
    data: { role: "admin" },
  });
  console.log(`linhas atualizadas: ${res.count}`);

  const after = await prisma.user.findMany({
    where: { email: { equals: EMAIL, mode: "insensitive" }, deletedAt: null },
    select: { email: true, role: true },
  });
  console.log("depois    :", after);
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FALHOU:", e instanceof Error ? e.message : e); process.exit(1); });

/** READ-ONLY: mostra pra qual banco o .env aponta e o que tem na tabela users. */
export {};
for (const file of [".env.local", ".env"]) {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(file);
  } catch {}
}
async function main() {
  const url = new URL(process.env.DATABASE_URL as string);
  console.log("DB host   :", url.hostname);
  console.log("DB name   :", url.pathname.replace(/^\//, ""));
  const { getUsers } = await import("../lib/data/users");
  const rows = await getUsers();
  console.log(`\nusers (nao-deletados): ${rows.length}`);
  for (const r of rows) console.log(`  - ${r.email} | ${r.name ?? "sem nome"} | role=${r.role} | clerk=${r.clerkUserId}`);
  const { prisma } = await import("../lib/db");
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FALHOU:", e instanceof Error ? e.message : e); process.exit(1); });

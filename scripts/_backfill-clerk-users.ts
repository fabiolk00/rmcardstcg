/**
 * One-off: backfill de TODOS os usuarios do Clerk para a tabela `users` (o que o
 * webhook faria em cada user.created). Idempotente (upsert por clerk_user_id),
 * NAO rebaixa admin existente, NAO promove ninguem (role=cliente por default —
 * admin fica pra depois). Rodar: pnpm tsx scripts/_backfill-clerk-users.ts
 * Apagar depois de usar.
 */
export {};

for (const file of [".env.local", ".env"]) {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(file);
  } catch {
    // ausente / runtime sem loadEnvFile — segue com o env ja presente
  }
}

type ClerkEmail = { id: string; email_address: string };
type ClerkUser = {
  id: string;
  email_addresses?: ClerkEmail[];
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

function primaryEmail(u: ClerkUser): string | null {
  const list = u.email_addresses ?? [];
  const primary = list.find((e) => e.id === u.primary_email_address_id);
  return (primary ?? list[0])?.email_address ?? null;
}
function fullName(u: ClerkUser): string | null {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

async function fetchAllClerkUsers(secret: string): Promise<ClerkUser[]> {
  const all: ClerkUser[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const res = await fetch(
      `https://api.clerk.com/v1/users?limit=${limit}&offset=${offset}&order_by=-created_at`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    if (!res.ok) throw new Error(`Clerk API ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as ClerkUser[];
    all.push(...page);
    if (page.length < limit) break;
  }
  return all;
}

async function main() {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("CLERK_SECRET_KEY nao definida no .env");

  // import dinamico: lib/data/users -> lib/db lanca se DATABASE_URL faltar
  const { upsertUserFromClerk, getUsers } = await import("../lib/data/users");

  console.log("DB host   :", new URL(process.env.DATABASE_URL as string).hostname);

  const users = await fetchAllClerkUsers(secret);
  console.log(`Clerk retornou ${users.length} usuario(s). Sincronizando...\n`);

  let ok = 0;
  let skipped = 0;
  for (const u of users) {
    const email = primaryEmail(u);
    if (!email) {
      console.warn(`  SKIP ${u.id} (sem e-mail)`);
      skipped++;
      continue;
    }
    await upsertUserFromClerk({
      clerkUserId: u.id,
      email,
      name: fullName(u),
      emailIsAdmin: false, // admin resolvido depois; upsert nunca rebaixa admin existente
    });
    console.log(`  OK   ${email} (${fullName(u) ?? "sem nome"})`);
    ok++;
  }

  const rows = await getUsers();
  console.log(`\nSincronizados: ${ok} | pulados: ${skipped}`);
  console.log(`Tabela users agora tem ${rows.length} registro(s) (nao-deletados):`);
  for (const r of rows) console.log(`  - ${r.email} | ${r.name ?? "sem nome"} | role=${r.role}`);

  const { prisma } = await import("../lib/db");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("FALHOU:", e instanceof Error ? e.message : e);
  process.exit(1);
});

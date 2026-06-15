import { prisma } from "../db";

/**
 * Camada de dados de usuarios — espelho local do Clerk (F9).
 *
 * O webhook do Clerk (app/api/webhooks/clerk) mantem esta tabela em dia. A role
 * (cliente/admin) e a fonte de verdade da autorizacao no server, ja que o auth e
 * Clerk e nao Supabase Auth.
 */
export type Role = "cliente" | "admin";

/** Upsert do usuario vindo do Clerk. Nunca rebaixa um admin existente. */
export async function upsertUserFromClerk(input: {
  clerkUserId: string;
  email: string;
  name: string | null;
  emailIsAdmin: boolean;
}): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { clerkUserId: input.clerkUserId },
    select: { role: true },
  });
  const role: Role = input.emailIsAdmin || existing?.role === "admin" ? "admin" : "cliente";

  await prisma.user.upsert({
    where: { clerkUserId: input.clerkUserId },
    create: { clerkUserId: input.clerkUserId, email: input.email, name: input.name, role },
    update: { email: input.email, name: input.name, role },
  });
}

/** Remove o usuario (evento user.deleted). updateMany-style: nao lanca se nao existir. */
export async function deleteUserByClerkId(clerkUserId: string): Promise<void> {
  await prisma.user.deleteMany({ where: { clerkUserId } });
}

/** Role do usuario; null se ainda nao sincronizado. */
export async function getUserRole(clerkUserId: string): Promise<Role | null> {
  const user = await prisma.user.findUnique({
    where: { clerkUserId },
    select: { role: true },
  });
  return user ? (user.role as Role) : null;
}

"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/requireAdmin";
import { setUserRole, type Role, type SetUserRoleResult } from "@/lib/data/users";

/**
 * Server actions de usuario (admin). Espelha a arquitetura dos cupons:
 * 1) re-verifica a role no server via requireAdmin (invariante 4);
 * 2) valida o payload no server (nunca confiar no client);
 * 3) delega para a data layer, que grava audit_log na MESMA transacao;
 * 4) revalidatePath("/admin/usuarios").
 *
 * NOTA: arquivo "use server" so exporta funcoes async; o dynamic vive na page.
 */

function fail(error: string): SetUserRoleResult {
  return { ok: false, error };
}

function isRole(value: unknown): value is Role {
  return value === "cliente" || value === "admin";
}

/** Altera a role de um usuario. A guarda anti-lockout vive em setUserRole. */
export async function setUserRoleAction(
  clerkUserId: string,
  role: Role,
): Promise<SetUserRoleResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return fail(guard.error);
  if (!clerkUserId) return fail("Usuário inválido.");
  if (!isRole(role)) return fail("Função inválida.");

  const result = await setUserRole(guard.actor, clerkUserId, role);
  if (result.ok) revalidatePath("/admin/usuarios");
  return result;
}

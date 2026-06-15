import { getAuditActor, type AuditActor } from "@/lib/data/audit";
import { isClerkConfigured } from "@/lib/services/clerk/config";

/**
 * Guard de admin compartilhado (FUNDACAO) — re-verificacao de role no server
 * (invariante 4), DRY entre os server actions de produto/pedido/cupom.
 *
 * Espelha app/admin/layout.tsx: com Clerk ativo exige role 'admin'; mock-first
 * (sem Clerk) libera em dev e e fail-closed em producao. Em sucesso devolve o
 * AuditActor ja resolvido para a trilha de auditoria (evita resolver 2x).
 */
export type AdminGuardResult = { ok: true; actor: AuditActor } | { ok: false; error: string };

const FORBIDDEN = "Acesso negado." as const;

export async function requireAdmin(): Promise<AdminGuardResult> {
  const actor = await getAuditActor();

  if (!isClerkConfigured()) {
    // Mock-first: liberado em dev; fail-closed em producao (sem chaves Clerk).
    if (process.env.NODE_ENV === "production") {
      return { ok: false, error: FORBIDDEN };
    }
    return { ok: true, actor };
  }

  if (actor.role !== "admin") {
    return { ok: false, error: FORBIDDEN };
  }
  return { ok: true, actor };
}

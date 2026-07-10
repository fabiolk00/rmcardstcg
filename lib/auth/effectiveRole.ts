import { isAdminEmail } from "@/lib/services/clerk/roles";

import type { Role } from "@/lib/data/users";

/**
 * Decisao COMPARTILHADA de role efetiva (FUNDACAO) — DRY entre os tres pontos que
 * antes copiavam `getUserRole(id) ?? (isAdminEmail(email) ? "admin" : "cliente")`:
 * app/admin/layout.tsx, lib/auth/resolveViewer e lib/data/audit#getAuditActor.
 *
 * Por que existe (bug do "admin virou cliente"): a expressao antiga colapsava
 * DOIS estados diferentes em "cliente":
 *   (1) DB confirma que o usuario NAO e admin  -> cliente de verdade
 *   (2) NAO deu pra confirmar a role (espelho ainda sem sync E o e-mail do Clerk
 *       nao resolveu — ex.: currentUser() vazio num re-handshake pos-idle)
 * Tratar (2) como "cliente" rebaixa silenciosamente um admin cujo acesso vinha do
 * fallback ADMIN_EMAILS. Aqui (2) vira "unverified" — recuperavel, nunca um
 * rebaixamento definitivo — e o chamador decide (re-autenticar vs seguir anon).
 *
 * Fonte de verdade continua o DB (role do espelho). ADMIN_EMAILS e so bootstrap
 * para quem ainda nao sincronizou; `source: "allowlist"` sinaliza esse estado
 * FRAGIL (admin sustentado so pelo e-mail) para o chamador logar.
 *
 * Pura (so depende de isAdminEmail, que le env) — testavel sem DB/rede.
 */
export type RoleDecision =
  | { role: "admin"; source: "db" | "allowlist" }
  | { role: "cliente" }
  | { role: "unverified" };

export function effectiveRole(dbRole: Role | null, email: string | null): RoleDecision {
  if (dbRole === "admin") return { role: "admin", source: "db" };
  if (dbRole === "cliente") return { role: "cliente" };

  // dbRole null: ausente/dessincronizado. Sem e-mail, nao da pra checar a allowlist.
  if (email === null) return { role: "unverified" };
  return isAdminEmail(email) ? { role: "admin", source: "allowlist" } : { role: "cliente" };
}

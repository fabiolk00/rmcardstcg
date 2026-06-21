import { redirect } from "next/navigation";

import { getAuditActor } from "@/lib/data/audit";
import { isClerkConfigured } from "@/lib/services/clerk/config";

// Roteador pos-login: decide o destino pela ROLE, no servidor. SignIn/SignUp caem
// aqui pelo fallbackRedirectUrl (so quando NAO ha redirect_url na query — deep
// links de rota protegida sao preservados pelo middleware e tem prioridade).
export const dynamic = "force-dynamic";

/**
 * Destino pos-login por papel:
 *  - admin   -> /admin/produtos (landing do painel; nao existe /admin bare)
 *  - cliente -> /minhas-compras ("meus pedidos")
 *
 * A role e resolvida pelo MESMO caminho do guard de admin (getAuditActor: role do
 * DB com fallback ADMIN_EMAILS), entao um admin recem-criado cujo webhook ainda nao
 * sincronizou ja cai no painel pela allowlist. Mock-first (sem Clerk): nao ha login
 * real, manda pra home. Sem usuario (hit direto deslogado): manda pro /entrar.
 */
export default async function PosLoginPage() {
  if (!isClerkConfigured()) redirect("/");

  const actor = await getAuditActor();
  if (!actor.clerkUserId) redirect("/entrar");

  redirect(actor.role === "admin" ? "/admin/produtos" : "/minhas-compras");
}

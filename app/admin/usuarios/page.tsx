import { getAuditActor } from "@/lib/data/audit";
import { getUsers } from "@/lib/data/users";
import { AdminUsersView } from "@/components/admin/AdminUsersView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminUsuariosPage() {
  // Resolve o ator atual em paralelo com a lista; o clerkUserId do admin logado
  // desabilita a troca de role na PROPRIA linha na view (guarda anti-lockout
  // espelhada do server em setUserRole). Mock-first: actor.clerkUserId e null.
  const [users, actor] = await Promise.all([getUsers(), getAuditActor()]);
  return <AdminUsersView users={users} currentClerkUserId={actor.clerkUserId} />;
}

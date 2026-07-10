import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { effectiveRole } from "@/lib/auth/effectiveRole";
import { getUserRole, isUserSoftDeleted } from "@/lib/data/users";
import { isClerkConfigured } from "@/lib/services/clerk/config";

/**
 * Papel EFETIVO do visitante para roteamento de vitrine -> painel.
 *
 * Regra de produto: cliente LOGADO vive no painel (/painel/*) — a vitrine
 * publica e para anonimos. Admin NAO e redirecionado (o dono precisa navegar a
 * propria loja logado). Soft-deleted nao e redirecionado para o painel (o guard
 * de la o devolveria para a home: seria loop) — fica na vitrine como anonimo.
 *
 * Custo: anon/mock-first = so auth() (JWT local, sem rede); logado = 1 leitura
 * de role no banco (o fallback ADMIN_EMAILS via currentUser so roda quando a
 * role ainda nao sincronizou). Falha de leitura => trata como anon (a vitrine
 * nunca cai por causa do roteamento).
 */
export type Viewer =
  | { kind: "anon" }
  | { kind: "deleted" }
  | { kind: "admin"; userId: string }
  | { kind: "cliente"; userId: string };

export async function resolveViewer(): Promise<Viewer> {
  if (!isClerkConfigured()) return { kind: "anon" };

  const { userId } = await auth();
  if (!userId) return { kind: "anon" };

  try {
    const role = await getUserRole(userId); // filtra deletedAt (null = ausente OU deletado)
    if (role === "admin") return { kind: "admin", userId };
    if (role === "cliente") return { kind: "cliente", userId };

    // role null: distingue soft-deleted de recem-criado-sem-sync.
    if (await isUserSoftDeleted(userId)) return { kind: "deleted" };
    const user = await currentUser();
    const email =
      user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses[0]?.emailAddress ?? null;
    const decision = effectiveRole(null, email);
    if (decision.role === "admin") return { kind: "admin", userId };
    if (decision.role === "cliente") return { kind: "cliente", userId };
    // "unverified" (e-mail nao resolveu): trata como anon — a vitrine so redireciona
    // "cliente" ao painel, entao anon aqui mantem o usuario na vitrine publica sem
    // colapsar um estado indeterminado num papel confirmado.
    return { kind: "anon" };
  } catch (err) {
    console.error(
      "[auth] resolveViewer falhou (segue como anon):",
      err instanceof Error ? err.message : err,
    );
    return { kind: "anon" };
  }
}

/**
 * Roteia o CLIENTE logado da vitrine para o equivalente no painel (regra
 * "tudo direciona pro dashboard sendo cliente"). Anon/admin/deleted seguem na
 * vitrine. Chamar no TOPO das pages publicas com espelho no painel.
 */
export async function redirectClienteToPainel(dest: string): Promise<void> {
  const viewer = await resolveViewer();
  if (viewer.kind === "cliente") redirect(dest);
}

import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { effectiveRole } from "@/lib/auth/effectiveRole";
import { getUserRole, isUserSoftDeleted } from "@/lib/data/users";
import { isClerkConfigured } from "@/lib/services/clerk/config";

/**
 * Papel EFETIVO do visitante para roteamento de vitrine -> area logada.
 *
 * Regra de produto: quem esta LOGADO vive na sua area — cliente no painel
 * (/painel/*), admin no /admin. A vitrine publica e so para anonimos. Soft-deleted
 * nao e roteado (o guard da area o devolveria para a home: seria loop) — fica na
 * vitrine como anonimo.
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
 * Destino de redirect da vitrine para um visitante LOGADO (PURA — testavel sem
 * I/O): admin -> /admin; cliente -> espelho no painel (`clienteDest`); anon e
 * deleted ficam na vitrine (null = sem redirect).
 */
export function storefrontRedirectTarget(viewer: Viewer, clienteDest: string): string | null {
  if (viewer.kind === "admin") return "/admin";
  if (viewer.kind === "cliente") return clienteDest;
  return null;
}

/**
 * Roteia o visitante LOGADO da vitrine para a sua area (regra "quem esta logado
 * vive na sua area"): admin -> /admin; cliente -> espelho no painel
 * (`clienteDest`). Anon/deleted seguem na vitrine. Chamar no TOPO das pages
 * publicas da vitrine que tem espelho na area logada.
 */
export async function redirectLoggedInFromStorefront(clienteDest: string): Promise<void> {
  const target = storefrontRedirectTarget(await resolveViewer(), clienteDest);
  if (target) redirect(target);
}

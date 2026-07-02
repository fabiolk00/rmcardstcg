import { auth } from "@clerk/nextjs/server";

import { isUserSoftDeleted } from "@/lib/data/users";
import { isClerkConfigured } from "@/lib/services/clerk/config";

/**
 * Guard do CLIENTE autenticado (irmao do requireAdmin): resolve a sessao Clerk
 * E confere que o espelho local nao esta SOFT-DELETED antes de servir tela/action
 * de conta (Minhas Compras, PIX, avaliacao, checkout).
 *
 * Por que existe: a autenticacao primaria e o Clerk, mas a sessao pode
 * sobreviver por instantes ao user.deleted, e o espelho pode ser desativado
 * direto no banco sem passar pelo Clerk — sem esta checagem, um usuario
 * desativado com sessao valida seguiria comprando e lendo os proprios pedidos.
 *
 * Politica:
 *  - mock-first (sem Clerk): "guest", como todas as superficies ja fazem;
 *  - sem sessao: unauthenticated (paginas redirecionam p/ /entrar, actions erram);
 *  - deletedAt no espelho: deleted (bloqueia);
 *  - AUSENTE do espelho: PERMITE (webhook de sync pode nao ter chegado — so o
 *    deletedAt explicito bloqueia);
 *  - falha na LEITURA do espelho: FAIL-OPEN com log. Racional: este guard e
 *    defense-in-depth por cima do Clerk (que continua sendo a autenticacao);
 *    falhar-fechado transformaria uma indisponibilidade de banco em queda de
 *    toda a area logada, sem ganho real — as queries seguintes ja falhariam.
 */
export type ActiveUserResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "unauthenticated" | "deleted" };

/** Mensagem padrao para actions quando o guard bloqueia por conta desativada. */
export const DEACTIVATED_ACCOUNT_ERROR = "Conta desativada. Entre em contato com a loja.";

export async function requireActiveUser(): Promise<ActiveUserResult> {
  if (!isClerkConfigured()) return { ok: true, userId: "guest" };

  const { userId } = await auth();
  if (!userId) return { ok: false, reason: "unauthenticated" };

  try {
    if (await isUserSoftDeleted(userId)) {
      console.warn("[auth] sessao de usuario soft-deleted bloqueada", { clerkUserId: userId });
      return { ok: false, reason: "deleted" };
    }
  } catch (err) {
    console.error(
      "[auth] checagem de soft-delete falhou (fail-open):",
      err instanceof Error ? err.message : err,
    );
  }
  return { ok: true, userId };
}

"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/requireAdmin";
import { setReviewStatus } from "@/lib/data/reviews";

/**
 * Server actions de moderacao de avaliacao (admin). Cada action re-verifica a role
 * no server (requireAdmin, invariante 4) e delega para a data layer, que aplica o
 * status + recalc do agregado + audit_log na MESMA transacao.
 */

export type ReviewModerationActionResult = { ok: true } | { ok: false; error: string };

async function moderate(
  id: string,
  target: "approved" | "rejected",
): Promise<ReviewModerationActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!id) return { ok: false, error: "Avaliação inválida." };

  const res = await setReviewStatus(guard.actor, id, target);
  if (!res.ok) return { ok: false, error: "Avaliação não encontrada." };

  revalidatePath("/admin/avaliacoes");
  // O recalc de rating/reviewCount reflete na pagina de produto (force-dynamic) na
  // proxima visita; no catalogo (colecoes, unstable_cache) em ate 60s pelo TTL.
  return { ok: true };
}

export async function approveReviewAction(id: string): Promise<ReviewModerationActionResult> {
  return moderate(id, "approved");
}

export async function rejectReviewAction(id: string): Promise<ReviewModerationActionResult> {
  return moderate(id, "rejected");
}

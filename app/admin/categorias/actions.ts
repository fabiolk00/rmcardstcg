"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  CategoryValidationError,
  createCategory,
  deleteCategory,
  updateCategory,
  type CategoryDeleteResult,
  type CategoryInput,
  type CategoryMutationResult,
} from "@/lib/data/categories";

/**
 * Server actions de categoria (admin). Toda action:
 * 1) re-verifica a role no server via requireAdmin (invariante 4);
 * 2) delega para a data layer, que valida/normaliza e grava audit_log na
 *    MESMA transacao;
 * 3) revalidatePath("/admin/categorias").
 *
 * NOTA: nao exportar runtime/dynamic daqui (arquivo "use server" so exporta
 * funcoes async). A page (app/admin/categorias/page.tsx) ja garante dynamic.
 */

/** Payload do formulario (strings da UI -> CategoryInput). */
export type CategoryFormPayload = {
  name: string;
  description?: string | null;
};

function toInput(p: CategoryFormPayload): CategoryInput {
  return { name: p.name ?? "", description: p.description ?? null };
}

/** Converte erro em mensagem amigavel (nunca vaza stack). */
function toErrorMessage(err: unknown): string {
  if (err instanceof CategoryValidationError) return err.message;
  console.error("[admin/categorias] ação falhou:", err instanceof Error ? err.message : err);
  return "Não foi possível concluir a operação. Tente novamente.";
}

export async function createCategoryAction(
  payload: CategoryFormPayload,
): Promise<CategoryMutationResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  try {
    const result = await createCategory(guard.actor, toInput(payload));
    if (result.ok) revalidatePath("/admin/categorias");
    return result;
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function updateCategoryAction(
  id: string,
  payload: CategoryFormPayload,
): Promise<CategoryMutationResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!id) return { ok: false, error: "Categoria inválida." };

  try {
    const result = await updateCategory(guard.actor, id, toInput(payload));
    if (result.ok) revalidatePath("/admin/categorias");
    return result;
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

/** Exclusao permanente (hard delete — catalogo desacoplado, sem guarda de "em uso"). */
export async function deleteCategoryAction(id: string): Promise<CategoryDeleteResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!id) return { ok: false, error: "Categoria inválida." };

  const result = await deleteCategory(guard.actor, id);
  if (result.ok) revalidatePath("/admin/categorias");
  return result;
}

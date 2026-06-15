"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  ProductValidationError,
  createProduct,
  setProductActive,
  updateProduct,
  type ProductInput,
} from "@/lib/data/products";
import type { Product } from "@/lib/data/types";

/**
 * Server actions de CRUD de produto (consumidas por AdminProductsView).
 *
 * Cada action: (1) re-verifica role admin no SERVIDOR via requireAdmin (invariante
 * 4) — nao basta o layout, pois actions sao endpoints invocaveis; (2) delega a
 * lib/data/products (que valida + audita na mesma transacao); (3) revalidatePath
 * para refletir no SSR. Erros viram { ok:false } com mensagem amigavel.
 */

const ADMIN_PATH = "/admin/produtos";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Converte erro em mensagem amigavel (nunca vaza stack). */
function toErrorMessage(err: unknown): string {
  if (err instanceof ProductValidationError) return err.message;
  console.error("[admin/produtos] ação falhou:", err instanceof Error ? err.message : err);
  return "Não foi possível concluir a operação. Tente novamente.";
}

export async function createProductAction(input: ProductInput): Promise<ActionResult<Product>> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  try {
    const product = await createProduct(guard.actor, input);
    revalidatePath(ADMIN_PATH);
    return { ok: true, data: product };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function updateProductAction(
  id: string,
  input: ProductInput,
): Promise<ActionResult<Product>> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  try {
    const product = await updateProduct(guard.actor, id, input);
    revalidatePath(ADMIN_PATH);
    return { ok: true, data: product };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

export async function setProductActiveAction(
  id: string,
  isActive: boolean,
): Promise<ActionResult<Product>> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  try {
    const product = await setProductActive(guard.actor, id, isActive);
    revalidatePath(ADMIN_PATH);
    return { ok: true, data: product };
  } catch (err) {
    return { ok: false, error: toErrorMessage(err) };
  }
}

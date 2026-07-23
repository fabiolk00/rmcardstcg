"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  ProductValidationError,
  createProduct,
  deleteProduct,
  setProductActive,
  updateProduct,
  type ProductDeleteResult,
  type ProductInput,
} from "@/lib/data/products";
import type { Product } from "@/lib/data/types";
import { clientRateLimitKey } from "@/lib/security/clientKey";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { isSupabaseStorageConfigured } from "@/lib/services/supabase/config";
import {
  MAX_IMAGE_BYTES,
  SupabaseStorageError,
  isAcceptedImageType,
  uploadProductImage,
} from "@/lib/services/supabase/storage";

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
  // Snapshot que o form carregou (client baseline) p/ o diff de intencao do servidor.
  // Opcional: ausente -> updateProduct cai no baseline do servidor (legado).
  original?: ProductInput,
): Promise<ActionResult<Product>> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  try {
    const product = await updateProduct(guard.actor, id, input, original);
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

/**
 * Exclusao permanente (o "D" do CRUD). Bloqueada para produto ja vendido: a data layer
 * conta order_items e recusa com mensagem amigavel (produto vendido deve ser inativado).
 */
export async function deleteProductAction(id: string): Promise<ProductDeleteResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!id) return { ok: false, error: "Produto inválido." };

  const result = await deleteProduct(guard.actor, id);
  if (result.ok) revalidatePath(ADMIN_PATH);
  return result;
}

/**
 * Upload de imagem de produto para o Supabase Storage. Endpoint invocavel: re-checa
 * admin (invariante 4). Valida formato e tamanho no SERVIDOR (a checagem no client
 * e so UX); o nome do arquivo e gerado no Storage (uuid). Devolve a URL publica, que
 * o formulario grava em imageUrl no save normal (create/updateProductAction).
 */
export async function uploadProductImageAction(formData: FormData): Promise<ActionResult<string>> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  // Rate limit por-ator (admin-only ja e a 1a barreira; isto e defense-in-depth
  // contra abuso/upload em rajada mesmo com conta admin comprometida). Mesmo
  // padrao/store das demais actions — 10 uploads/min.
  const limited = await checkRateLimit(
    `upload-image:${await clientRateLimitKey(guard.actor.clerkUserId ?? "guest")}`,
    { limit: 10, windowMs: 60_000 },
  );
  if (!limited.allowed) {
    return { ok: false, error: "Muitas tentativas. Aguarde um instante." };
  }

  if (!isSupabaseStorageConfigured()) {
    return { ok: false, error: "Upload de imagem não configurado no servidor." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Selecione um arquivo de imagem." };
  }
  if (!isAcceptedImageType(file.type)) {
    return { ok: false, error: "Formato inválido. Use PNG, JPG, WEBP ou GIF." };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: "Imagem muito grande (máx. 4 MB)." };
  }

  try {
    const url = await uploadProductImage(await file.arrayBuffer(), file.type);
    return { ok: true, data: url };
  } catch (err) {
    const detail = err instanceof SupabaseStorageError ? `${err.status} ${err.message}` : err;
    console.error("[admin/produtos] upload de imagem falhou:", detail);
    return { ok: false, error: "Não foi possível enviar a imagem. Tente novamente." };
  }
}

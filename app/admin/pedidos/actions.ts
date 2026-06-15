"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  type AdminOrderUpdate,
  adjustOrderPaymentStatus,
  updateOrderInternalNote,
  updateOrderShippingStatus,
} from "@/lib/data/orders";
import type { Order, PaymentStatus, ShippingStatus } from "@/lib/data/types";

/**
 * Server actions de atualizacao de pedido (admin). Re-verificam role admin no
 * server via requireAdmin (invariante 4) e montam o AuditActor antes de chamar a
 * data layer (que audita na mesma transacao). revalidatePath quando muda de fato.
 *
 * NOTA: nao exportar `runtime`/`dynamic` daqui — um arquivo "use server" so pode
 * exportar funcoes async. A page (app/admin/pedidos/page.tsx) ja garante dynamic.
 */

const ADMIN_PEDIDOS_PATH = "/admin/pedidos";

/** Resultado serializavel das actions p/ o client. */
export type OrderActionResult =
  | { ok: true; changed: boolean; order: Order }
  | { ok: false; error: string };

/** '#10421' -> 10421; null se nao for um id valido. */
function parseOrderId(id: string): number | null {
  const n = Number(id.replace(/^#/, ""));
  return Number.isInteger(n) ? n : null;
}

/** Normaliza o retorno da data layer em mensagem amigavel (ou propaga sucesso). */
function toActionResult(res: AdminOrderUpdate): OrderActionResult {
  if (res.ok) return { ok: true, changed: res.changed, order: res.order };
  switch (res.reason) {
    case "not_found":
      return { ok: false, error: "Pedido não encontrado." };
    case "invalid_transition":
      return { ok: false, error: `Transição de envio inválida (${res.from} → ${res.to}).` };
  }
}

/** Atualiza o status de ENVIO de um pedido. */
export async function updateShippingStatusAction(
  orderId: string,
  to: ShippingStatus,
): Promise<OrderActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  const numericId = parseOrderId(orderId);
  if (numericId === null) return { ok: false, error: "Pedido inválido." };

  const res = await updateOrderShippingStatus(numericId, to, guard.actor);
  if (res.ok && res.changed) revalidatePath(ADMIN_PEDIDOS_PATH);
  return toActionResult(res);
}

/** Atualiza a NOTA INTERNA de um pedido. */
export async function updateInternalNoteAction(
  orderId: string,
  note: string,
): Promise<OrderActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  const numericId = parseOrderId(orderId);
  if (numericId === null) return { ok: false, error: "Pedido inválido." };

  const res = await updateOrderInternalNote(numericId, note, guard.actor);
  if (res.ok && res.changed) revalidatePath(ADMIN_PEDIDOS_PATH);
  return toActionResult(res);
}

/**
 * AJUSTE MANUAL do status de PAGAMENTO. Exige motivo (trilha de auditoria) —
 * fail-closed se vier vazio. Segregado do webhook do Asaas.
 */
export async function adjustPaymentStatusAction(
  orderId: string,
  to: PaymentStatus,
  reason: string,
): Promise<OrderActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  const numericId = parseOrderId(orderId);
  if (numericId === null) return { ok: false, error: "Pedido inválido." };

  if (!reason || reason.trim().length < 3) {
    return { ok: false, error: "Informe um motivo para o ajuste manual de pagamento." };
  }

  const res = await adjustOrderPaymentStatus(numericId, to, reason, guard.actor);
  if (res.ok && res.changed) revalidatePath(ADMIN_PEDIDOS_PATH);
  return toActionResult(res);
}

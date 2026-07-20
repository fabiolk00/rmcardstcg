"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/requireAdmin";
import { getOrderById, updateOrderShippingStatus, updateOrderTracking } from "@/lib/data/orders";
import { getProductsByIds } from "@/lib/data/products";
import {
  getOrderLabel,
  markLabelCanceled,
  persistLabel,
  prismaLabelStore,
  saveLabelUrl,
} from "@/lib/data/shippingLabels";
import type { Order } from "@/lib/data/types";
import { buildLabelDraft, carrierForServiceCode, type LabelDraftItem } from "@/lib/shipping/labelDraft";
import { effectivePackage } from "@/lib/services/superfrete/dimensions";
import {
  cancelLabel,
  createLabel,
  printLabel,
  SuperFreteLabelError,
} from "@/lib/services/superfrete/labels";
import type { PrintFormat } from "@/lib/services/superfrete/label-types";
import { senderAddress } from "@/lib/services/superfrete/sender";

/**
 * Emissao de etiqueta pelo admin (fluxo /admin/pedidos).
 *
 * Ordem deliberada: valida TUDO que e local antes de qualquer chamada que gaste
 * dinheiro. Emitir etiqueta debita a carteira SuperFrete — um erro de endereco
 * descoberto pelo provedor ja custou. Idempotencia por `pedido-<id>` com store
 * em BANCO (lib/data/shippingLabels): retry nunca paga duas vezes.
 *
 * Arquivo separado de actions.ts para nao misturar o que gasta dinheiro com as
 * mutacoes de status comuns.
 */

const ADMIN_PEDIDOS_PATH = "/admin/pedidos";

export type LabelActionResult =
  | { ok: true; order: Order; message: string }
  | { ok: false; error: string };

export type PrintActionResult = { ok: true; url: string } | { ok: false; error: string };

function parseOrderId(id: string): number | null {
  const n = Number(id.replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Traduz o erro tipado do modulo de etiqueta em mensagem para o admin. */
function labelErrorMessage(err: unknown): string {
  if (err instanceof SuperFreteLabelError) {
    switch (err.code) {
      case "insufficient_balance":
        return "Saldo insuficiente na carteira SuperFrete. Recarregue e tente de novo — nada foi cobrado.";
      case "validation":
        return `A transportadora recusou os dados do envio: ${err.message}`;
      case "unavailable":
        return "A transportadora não atende esta rota ou modalidade para este pedido.";
      default:
        return `Falha ao falar com o SuperFrete: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : "Falha inesperada ao emitir a etiqueta.";
}

/**
 * Emite a etiqueta do pedido: valida, paga no provedor, persiste o vinculo,
 * grava rastreio + transportador e move o envio para "enviado".
 */
export async function issueLabelAction(orderId: string): Promise<LabelActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  const numericId = parseOrderId(orderId);
  if (numericId === null) return { ok: false, error: "Pedido inválido." };

  const order = await getOrderById(String(numericId));
  if (!order) return { ok: false, error: "Pedido não encontrado." };

  // Etiqueta e compromisso de envio: so para pedido PAGO e ainda nao despachado.
  if (order.paymentStatus !== "paid") {
    return { ok: false, error: "Só emitimos etiqueta de pedido pago." };
  }
  if (order.shippingStatus === "cancelled" || order.shippingStatus === "delivered") {
    return { ok: false, error: `Pedido com envio ${order.shippingStatus}: não cabe emitir etiqueta.` };
  }

  const sender = senderAddress();
  if (!sender.ok) return { ok: false, error: sender.error };

  // Medidas EFETIVAS dos produtos (as mesmas da cotacao): o pacote declarado na
  // etiqueta precisa bater com o que foi cotado, senao a reconferencia cobra a
  // diferenca da loja.
  const products = await getProductsByIds(order.items.map((i) => i.productId));
  const byId = new Map(products.map((p) => [p.id, p]));
  const items: LabelDraftItem[] = order.items.map((item) => {
    const product = byId.get(item.productId);
    return {
      name: item.productName,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      pkg: product
        ? effectivePackage(product)
        : // Produto removido do catalogo depois da venda: cai no default de
          // categoria desconhecida, que e conservador por construcao.
          effectivePackage({
            category: "",
            weightGrams: 0,
            lengthCm: 0,
            widthCm: 0,
            heightCm: 0,
          }),
    };
  });

  const draft = buildLabelDraft({
    order: {
      id: numericId,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      customerDocument: order.customerDocument,
      address: order.address,
      shippingServiceCode: order.shippingServiceCode,
    },
    sender: sender.sender,
    items,
  });
  if (!draft.ok) return { ok: false, error: draft.error };

  let created;
  try {
    created = await createLabel(draft.input, { store: prismaLabelStore });
  } catch (err) {
    console.error("[admin-label] falha ao emitir:", err);
    return { ok: false, error: labelErrorMessage(err) };
  }

  await persistLabel({
    orderId: numericId,
    superFreteId: created.superFreteId,
    status: created.status,
    paid: true,
    costCents: created.priceCents,
    trackingCode: created.trackingCode,
  });

  // Rastreio + transportador (audita na data layer). O codigo pode vir vazio: o
  // provedor so emite o rastreio na postagem — o admin atualiza depois.
  const carrier = carrierForServiceCode(draft.input.serviceCode);
  const tracked = await updateOrderTracking(
    numericId,
    { trackingCode: created.trackingCode, carrier },
    guard.actor,
  );
  if (!tracked.ok) return { ok: false, error: "Etiqueta emitida, mas o rastreio não foi salvo." };

  // Transicao pending -> sent (audita e valida a maquina de estados).
  let finalOrder = tracked.order;
  if (order.shippingStatus === "pending") {
    const moved = await updateOrderShippingStatus(numericId, "sent", guard.actor);
    if (moved.ok) finalOrder = moved.order;
  }

  revalidatePath(ADMIN_PEDIDOS_PATH);
  const custo = (created.priceCents / 100).toFixed(2).replace(".", ",");
  return {
    ok: true,
    order: finalOrder,
    message: created.reused
      ? `Etiqueta já existia para este pedido (R$ ${custo}) — nada foi cobrado de novo.`
      : `Etiqueta emitida por R$ ${custo}.`,
  };
}

/** Devolve a URL do PDF da etiqueta (A4 ou A6), guardando-a para os próximos cliques. */
export async function printLabelAction(
  orderId: string,
  format: PrintFormat,
): Promise<PrintActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  const numericId = parseOrderId(orderId);
  if (numericId === null) return { ok: false, error: "Pedido inválido." };

  const label = await getOrderLabel(numericId);
  if (!label) return { ok: false, error: "Este pedido ainda não tem etiqueta emitida." };

  try {
    const printed = await printLabel(label.superFreteId, format);
    await saveLabelUrl(numericId, printed.url);
    return { ok: true, url: printed.url };
  } catch (err) {
    console.error("[admin-label] falha ao imprimir:", err);
    return { ok: false, error: labelErrorMessage(err) };
  }
}

/**
 * Cancela a etiqueta no provedor. O valor volta como CREDITO na carteira, nunca
 * para a conta bancaria — por isso a confirmacao fica com o admin, na UI.
 */
export async function cancelLabelAction(orderId: string): Promise<LabelActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };

  const numericId = parseOrderId(orderId);
  if (numericId === null) return { ok: false, error: "Pedido inválido." };

  const label = await getOrderLabel(numericId);
  if (!label) return { ok: false, error: "Este pedido não tem etiqueta para cancelar." };

  let refunded = false;
  try {
    const res = await cancelLabel(label.superFreteId, "Cancelado pelo admin da loja");
    refunded = res.refunded;
  } catch (err) {
    console.error("[admin-label] falha ao cancelar:", err);
    return { ok: false, error: labelErrorMessage(err) };
  }

  await markLabelCanceled(numericId);
  // O rastreio da etiqueta cancelada nao vale mais; o status de envio fica como
  // esta (a maquina de estados nao volta de 'sent'), e o admin decide o proximo
  // passo — reemitir gera um envio novo no provedor.
  const cleared = await updateOrderTracking(numericId, { trackingCode: null, carrier: null }, guard.actor);

  revalidatePath(ADMIN_PEDIDOS_PATH);
  const order = cleared.ok ? cleared.order : ((await getOrderById(String(numericId))) as Order);
  return {
    ok: true,
    order,
    message: refunded
      ? "Etiqueta cancelada. O valor voltou como crédito na carteira SuperFrete."
      : "Etiqueta cancelada.",
  };
}

"use server";

import { DEACTIVATED_ACCOUNT_ERROR, requireActiveUser } from "@/lib/auth/requireActiveUser";
import { getOrderAsaasRefs, getOrderForUser } from "@/lib/data/orders";
import { isAsaasConfigured } from "@/lib/services/asaas/config";
import { getPayment, getPixQrCode } from "@/lib/services/asaas/payments";
import { clientRateLimitKey } from "@/lib/security/clientKey";
import { checkRateLimit } from "@/lib/security/rateLimit";

/**
 * Server action de RECUPERACAO do PIX de um pedido pendente (Minhas Compras).
 *
 * O QR so era exibido uma vez, logo apos o checkout. Aqui o cliente re-deriva o
 * MESMO QR da cobranca Asaas ja vinculada ao pedido (nao gera cobranca nova —
 * preserva a idempotencia do checkout). Sempre valida posse do pedido (anti-IDOR)
 * antes de tocar no Asaas.
 */

export type OrderPix = { payload: string; encodedImage: string; expirationDate: string };

export type OrderPixResult =
  | { ok: true; pix: OrderPix }
  // pix indisponivel por um motivo ESPERADO (nao-erro): pedido nao mais pendente,
  // Asaas off (mock-first), sem cobranca vinculada, ou QR temporariamente indisponivel.
  | { ok: false; reason: "not_pending" | "asaas_off" | "no_charge" | "qr_unavailable" }
  // erro de fluxo (auth/posse/limite) — mensagem amigavel para a UI.
  | { ok: false; reason: "error"; error: string };

export async function getOrderPix(orderId: string): Promise<OrderPixResult> {
  // Login + espelho ATIVO (sessao de usuario soft-deleted nao re-deriva PIX).
  const active = await requireActiveUser();
  if (!active.ok) {
    const error =
      active.reason === "deleted" ? DEACTIVATED_ACCOUNT_ERROR : "Faça login para ver o pagamento.";
    return { ok: false, reason: "error", error };
  }
  const userId = active.userId;

  const limited = await checkRateLimit(`order-pix:${await clientRateLimitKey(userId)}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!limited.allowed) {
    return { ok: false, reason: "error", error: "Muitas tentativas. Aguarde um instante." };
  }

  // Guard de posse (anti-IDOR): so o dono do pedido chega ao Asaas.
  const order = await getOrderForUser(orderId, userId);
  if (!order) return { ok: false, reason: "error", error: "Pedido não encontrado." };

  if (order.paymentStatus !== "pending") return { ok: false, reason: "not_pending" };
  if (!isAsaasConfigured()) return { ok: false, reason: "asaas_off" };

  const refs = await getOrderAsaasRefs(Number(order.id.replace(/^#/, "")));
  if (!refs?.paymentId) return { ok: false, reason: "no_charge" };

  try {
    const qr = await getPixQrCode(refs.paymentId);
    return {
      ok: true,
      pix: {
        payload: qr.payload,
        encodedImage: qr.encodedImage,
        expirationDate: qr.expirationDate,
      },
    };
  } catch (err) {
    console.warn("[minhas-compras] QR PIX indisponível:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "qr_unavailable" };
  }
}

/**
 * Recuperacao da FATURA (cartao) de um pedido pendente — analogo ao getOrderPix,
 * mas para cobrancas de cartao, que nao tem QR PIX. Re-deriva a invoiceUrl da
 * cobranca Asaas ja vinculada (nao cria cobranca nova) e valida posse (anti-IDOR).
 */
export type OrderInvoiceResult =
  | { ok: true; invoiceUrl: string }
  | { ok: false; reason: "not_pending" | "asaas_off" | "no_charge" | "unavailable" }
  | { ok: false; reason: "error"; error: string };

export async function getOrderInvoiceUrl(orderId: string): Promise<OrderInvoiceResult> {
  const active = await requireActiveUser();
  if (!active.ok) {
    const error =
      active.reason === "deleted" ? DEACTIVATED_ACCOUNT_ERROR : "Faça login para ver o pagamento.";
    return { ok: false, reason: "error", error };
  }
  const userId = active.userId;

  const limited = await checkRateLimit(`order-invoice:${await clientRateLimitKey(userId)}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!limited.allowed) {
    return { ok: false, reason: "error", error: "Muitas tentativas. Aguarde um instante." };
  }

  // Guard de posse (anti-IDOR): so o dono do pedido chega ao Asaas.
  const order = await getOrderForUser(orderId, userId);
  if (!order) return { ok: false, reason: "error", error: "Pedido não encontrado." };

  if (order.paymentStatus !== "pending") return { ok: false, reason: "not_pending" };
  if (!isAsaasConfigured()) return { ok: false, reason: "asaas_off" };

  const refs = await getOrderAsaasRefs(Number(order.id.replace(/^#/, "")));
  if (!refs?.paymentId) return { ok: false, reason: "no_charge" };

  try {
    const payment = await getPayment(refs.paymentId);
    if (!payment.invoiceUrl) return { ok: false, reason: "unavailable" };
    return { ok: true, invoiceUrl: payment.invoiceUrl };
  } catch (err) {
    console.warn("[minhas-compras] fatura indisponível:", err instanceof Error ? err.message : err);
    return { ok: false, reason: "unavailable" };
  }
}

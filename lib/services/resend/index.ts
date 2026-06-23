import { Resend } from "resend";

import OrderEmail, { type OrderEmailKind } from "@/emails/OrderEmail";
import type { Order } from "@/lib/data/types";

import { getResendConfig, isResendConfigured } from "./config";

/**
 * Envio transacional (F13). Mock-first: sem RESEND_API_KEY o envio e no-op.
 * Tolerante a falha: e-mail nunca derruba o checkout nem o webhook — erros sao
 * logados (so a mensagem) e engolidos.
 */
async function sendOrderEmail(order: Order, kind: OrderEmailKind): Promise<void> {
  if (!isResendConfigured() || !order.customerEmail) return;

  try {
    const { apiKey, from } = getResendConfig();
    const subject =
      kind === "paid"
        ? `Pagamento confirmado — pedido ${order.id}`
        : `Pedido ${order.id} recebido — RM Cards`;

    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: order.customerEmail,
      subject,
      react: OrderEmail({ order, kind }),
    });
    if (error) {
      console.error(`[resend] falha ao enviar (${kind}) pedido ${order.id}:`, error.message);
    }
  } catch (err) {
    console.error(
      `[resend] erro ao enviar (${kind}) pedido ${order.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Confirmacao de pedido recebido (apos o checkout criar o pedido). */
export function sendOrderConfirmationEmail(order: Order): Promise<void> {
  return sendOrderEmail(order, "created");
}

/** Confirmacao de pagamento (apos o webhook do Asaas marcar como pago). */
export function sendPaymentConfirmationEmail(order: Order): Promise<void> {
  return sendOrderEmail(order, "paid");
}

/**
 * Notifica o(s) admin(s) de uma nova avaliacao a moderar. Mock-first: no-op sem
 * RESEND_API_KEY ou sem ADMIN_EMAILS. Tolerante a falha (e-mail nunca derruba a
 * submissao) — erros sao logados e engolidos, como os e-mails de pedido.
 */
export async function sendReviewModerationEmail(input: {
  productName: string;
  authorName: string;
  rating: number;
  body: string;
}): Promise<void> {
  if (!isResendConfigured()) return;
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (admins.length === 0) return;

  try {
    const { apiKey, from } = getResendConfig();
    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: admins,
      subject: `Nova avaliação para moderar — ${input.productName}`,
      text:
        `${input.authorName} avaliou "${input.productName}" com ${input.rating}/5:\n\n` +
        `${input.body}\n\n` +
        `Modere em /admin/avaliacoes.`,
    });
    if (error) {
      console.error("[resend] falha ao notificar nova avaliação:", error.message);
    }
  } catch (err) {
    console.error(
      "[resend] erro ao notificar nova avaliação:",
      err instanceof Error ? err.message : err,
    );
  }
}

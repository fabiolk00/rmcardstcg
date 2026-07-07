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

/** Destinatarios admin (ADMIN_EMAILS, separados por virgula). Vazio = sem envio. */
function adminRecipients(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
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
  const admins = adminRecipients();
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

/** Motivo da rejeicao de um webhook de pagamento, para o alerta admin. */
export type WebhookRejectionAlert = {
  /** Pedido alvo (externalReference); null se o pedido nao foi encontrado. */
  orderId: number | null;
  /** Id da cobranca no Asaas (payment.id). */
  paymentId: string;
  /** Evento recebido (ex.: PAYMENT_RECEIVED). */
  event: string;
  /** Motivo: value_mismatch | payment_mismatch | invalid_transition | order_not_found. */
  reason: string;
};

/**
 * Alerta o(s) admin(s) quando um webhook de pagamento e REJEITADO pela validacao
 * de correlacao (valor nao bate, cobranca de outro pedido, transicao invalida,
 * pedido inexistente). Sem esse alerta a rejeicao vive so no console.warn e o
 * pedido pode ficar 'pending' para sempre sem ninguem perceber.
 *
 * Mock-first (no-op sem RESEND_API_KEY/ADMIN_EMAILS) e tolerante a falha —
 * e-mail nunca derruba o webhook; o ledger ja marcou o evento como processado.
 * Sem anti-spam extra: cada (cobranca, evento) rejeitado alerta 1x, porque o
 * reenvio do Asaas colide no ledger e vira duplicate antes de chegar aqui.
 */
export async function sendWebhookRejectionAlertEmail(input: WebhookRejectionAlert): Promise<void> {
  if (!isResendConfigured()) return;
  const admins = adminRecipients();
  if (admins.length === 0) return;

  try {
    const { apiKey, from } = getResendConfig();
    const pedido = input.orderId === null ? "pedido não encontrado" : `pedido #${input.orderId}`;
    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: admins,
      subject: `Webhook de pagamento rejeitado — ${pedido}`,
      text:
        `Um evento do Asaas foi rejeitado pela validação e NÃO alterou o pedido.\n\n` +
        `Evento: ${input.event}\n` +
        `Cobrança (Asaas): ${input.paymentId}\n` +
        `Pedido: ${input.orderId ?? "não encontrado"}\n` +
        `Motivo: ${input.reason}\n\n` +
        `O Asaas não vai reenviar (o evento foi confirmado e deduplicado). ` +
        `Verifique o pedido em /admin/pedidos e a cobrança no painel do Asaas.`,
    });
    if (error) {
      console.error("[resend] falha ao alertar webhook rejeitado:", error.message);
    }
  } catch (err) {
    console.error(
      "[resend] erro ao alertar webhook rejeitado:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Alerta o(s) admin(s) quando a RECONCILIACAO corrige um pedido que o webhook
 * deveria ter atualizado: o pedido ficou 'pending' por mais de 30min enquanto o
 * Asaas ja tinha status terminal — o webhook foi perdido ou esta atrasado
 * (fila pausada, URL/token errados, outage). O pedido em si foi corrigido; o
 * alerta e para investigar a CAUSA antes que outros webhooks se percam.
 *
 * 1 alerta por pedido: estados de pagamento terminais nao reincidem, entao o
 * mesmo pedido nunca e "corrigido" duas vezes. Mock-first e tolerante a falha,
 * como os demais e-mails.
 */
export async function sendWebhookMissedAlertEmail(input: {
  orderId: number;
  paymentId: string;
  /** Status aplicado pela reconciliacao (paid | cancelled). */
  status: string;
}): Promise<void> {
  if (!isResendConfigured()) return;
  const admins = adminRecipients();
  if (admins.length === 0) return;

  try {
    const { apiKey, from } = getResendConfig();
    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: admins,
      subject: `Webhook do Asaas perdido — pedido #${input.orderId} corrigido pela reconciliação`,
      text:
        `A reconciliação corrigiu o pedido #${input.orderId} para "${input.status}" ` +
        `consultando o Asaas diretamente — o webhook desse evento nunca chegou (ou chegou e falhou).\n\n` +
        `Cobrança (Asaas): ${input.paymentId}\n\n` +
        `O pedido está correto, mas investigue a causa no painel do Asaas ` +
        `(Integrações > Webhooks): fila pausada, URL/token incorretos ou instabilidade. ` +
        `Webhooks perdidos atrasam a confirmação dos próximos pedidos em até 30min.`,
    });
    if (error) {
      console.error("[resend] falha ao alertar webhook perdido:", error.message);
    }
  } catch (err) {
    console.error(
      "[resend] erro ao alertar webhook perdido:",
      err instanceof Error ? err.message : err,
    );
  }
}

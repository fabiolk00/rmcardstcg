import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { getOrderById, setOrderPaymentStatus } from "@/lib/data/orders";
import type { PaymentStatus } from "@/lib/data/types";
import { sendPaymentConfirmationEmail } from "@/lib/services/resend";

// Prisma (driver adapter pg) exige runtime Node — nunca Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook do Asaas — recebe eventos de cobranca e atualiza o paymentStatus do pedido.
 *
 * Correlacao pedido <-> cobranca: o checkout deve criar a cobranca no Asaas com
 * `externalReference = String(order.id)`. Aqui lemos `payment.externalReference`
 * de volta para achar o pedido. (Enquanto o fluxo checkout -> Asaas nao existir,
 * este handler apenas valida o token e responde 200.)
 *
 * Seguranca: o Asaas envia o token configurado no painel no header
 * `asaas-access-token`; comparamos com ASAAS_WEBHOOK_TOKEN (mesmo valor no .env).
 *
 * Contrato de resposta: 2xx confirma o evento para o Asaas. Em erro transitorio
 * (ex.: banco fora) devolvemos 500 de proposito, para o Asaas reenfileirar e
 * reenviar. Casos sem solucao (pedido inexistente, evento ignorado) sao 2xx.
 */

// Eventos do Asaas -> nosso modelo de 3 estados (pending | paid | cancelled).
const EVENT_TO_STATUS: Record<string, PaymentStatus> = {
  PAYMENT_CONFIRMED: "paid",
  PAYMENT_RECEIVED: "paid",
  PAYMENT_RECEIVED_IN_CASH: "paid",
  PAYMENT_REFUNDED: "cancelled",
  PAYMENT_DELETED: "cancelled",
  PAYMENT_REVERSED: "cancelled",
  PAYMENT_CHARGEBACK_REQUESTED: "cancelled",
};

function tokenMatches(received: string | null): boolean {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // timingSafeEqual exige buffers do mesmo tamanho.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!process.env.ASAAS_WEBHOOK_TOKEN) {
    // Misconfig do servidor: 500 (e nao "aceita tudo") para o Asaas reenfileirar.
    console.error("[asaas-webhook] ASAAS_WEBHOOK_TOKEN nao definido.");
    return NextResponse.json({ error: "webhook nao configurado" }, { status: 500 });
  }

  if (!tokenMatches(req.headers.get("asaas-access-token"))) {
    return NextResponse.json({ error: "token invalido" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "payload invalido" }, { status: 400 });
  }

  const { event, payment } = (body ?? {}) as {
    event?: string;
    payment?: { id?: string; externalReference?: string | null; value?: number };
  };

  // Eventos que nao mexem no status (PAYMENT_OVERDUE, PAYMENT_UPDATED, ...): so confirma.
  const status = event ? EVENT_TO_STATUS[event] : undefined;
  if (!status) {
    // Observabilidade: registra eventos novos/nao tratados sem reenfileirar.
    if (event) console.info(`[asaas-webhook] evento sem acao: ${event}`);
    return NextResponse.json({ received: true, ignored: event ?? null });
  }

  const orderId = Number(payment?.externalReference);
  if (!Number.isInteger(orderId)) {
    // Sem referencia valida nao da pra achar o pedido; confirma p/ nao reenfileirar.
    console.warn(
      `[asaas-webhook] ${event} sem externalReference numerico (payment ${payment?.id ?? "?"}).`,
    );
    return NextResponse.json({ received: true, matched: false });
  }

  // Valor do evento (reais) -> centavos, para conferir com o total do pedido.
  const valueCents = typeof payment?.value === "number" ? Math.round(payment.value * 100) : null;

  try {
    const result = await setOrderPaymentStatus(orderId, status, {
      id: payment?.id ?? "",
      valueCents,
    });
    if (!result.found) {
      console.warn(`[asaas-webhook] pedido #${orderId} nao encontrado (evento ${event}).`);
      return NextResponse.json({ received: true, matched: false });
    }
    if (!result.ok) {
      // Cobranca nao confere com o pedido (id ou valor): nao mexe no status.
      console.warn(
        `[asaas-webhook] evento ${event} rejeitado p/ pedido #${orderId}: ${result.reason}.`,
      );
      return NextResponse.json({ received: true, verified: false });
    }
    if (!result.changed) {
      // Idempotencia: reenvio do mesmo evento; o pedido ja estava nesse status.
      console.info(
        `[asaas-webhook] pedido #${orderId} ja estava "${status}" (evento ${event} reprocessado).`,
      );
    }

    // Pagamento recem-confirmado: dispara o e-mail (mock-first: no-op sem Resend).
    // Isolado para que falha de e-mail/leitura nao force reenvio do Asaas.
    if (result.changed && status === "paid") {
      try {
        const order = await getOrderById(`#${orderId}`);
        if (order) await sendPaymentConfirmationEmail(order);
      } catch (mailErr) {
        console.error(
          "[asaas-webhook] falha ao enviar e-mail de pagamento:",
          mailErr instanceof Error ? mailErr.message : mailErr,
        );
      }
    }

    return NextResponse.json({ received: true, orderId, status, changed: result.changed });
  } catch (err) {
    // Erro transitorio (ex.: banco): 500 para o Asaas reenviar. Loga so a mensagem.
    console.error(
      "[asaas-webhook] falha ao atualizar pedido:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "falha interna" }, { status: 500 });
  }
}

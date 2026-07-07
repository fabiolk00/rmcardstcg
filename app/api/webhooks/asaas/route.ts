import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { applyPaymentStatusTx } from "@/lib/data/orders";
import type { PaymentStatus } from "@/lib/data/types";
import {
  ASAAS_PROVIDER,
  isWebhookEventProcessed,
  markWebhookEventProcessed,
  recordWebhookEvent,
} from "@/lib/data/webhookEvents";
import {
  sendPaymentConfirmationEmail,
  sendWebhookRejectionAlertEmail,
} from "@/lib/services/resend";

// Prisma (driver adapter pg) exige runtime Node — nunca Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook do Asaas — recebe eventos de cobranca e atualiza o paymentStatus do pedido.
 *
 * Idempotencia em duas camadas, ambas na MESMA transacao do efeito:
 *  1. Ledger webhook_events (provider='asaas', event_id = payment.id + '|' + event):
 *     o mesmo (cobranca, tipo) reenviado vira no-op (responde 2xx, duplicate).
 *  2. Anti-replay por asaasPaymentId + compare-and-swap + conciliacao de estoque
 *     dentro de applyPaymentStatusTx.
 *
 * H3 (at-least-once correto): registrar o evento, aplicar o efeito e marcar
 * processed_at acontecem na MESMA transacao. Reprocessar e seguro enquanto
 * processed_at IS NULL (crash entre registrar e aplicar nao perde o efeito).
 *
 * Resposta: 2xx confirma ao Asaas. Erro transitorio -> 500 (reenfileira).
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

// Teto de payload do webhook. Eventos do Asaas sao pequenos (poucos KB); 256KB e
// folgado. Defesa contra DoS por corpo gigante: corta ANTES de bufferizar/parsear.
const MAX_WEBHOOK_BYTES = 256 * 1024;

function tokenMatches(received: string | null): boolean {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  // timingSafeEqual exige buffers do mesmo tamanho.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Id estavel do evento p/ o ledger. O Asaas nao envia um id de evento proprio,
 * entao combinamos a cobranca com o tipo: o mesmo (payment, event) reenviado
 * colide na unique (provider, event_id) e vira no-op.
 */
function asaasEventId(paymentId: string, event: string): string {
  return `${paymentId}|${event}`;
}

export async function POST(req: Request) {
  if (!process.env.ASAAS_WEBHOOK_TOKEN) {
    console.error("[asaas-webhook] ASAAS_WEBHOOK_TOKEN nao definido.");
    return NextResponse.json({ error: "webhook nao configurado" }, { status: 500 });
  }

  if (!tokenMatches(req.headers.get("asaas-access-token"))) {
    return NextResponse.json({ error: "token invalido" }, { status: 401 });
  }

  // Teto de payload (rejeita ANTES de parsear). Primeiro o Content-Length
  // declarado (corte barato); depois o tamanho REAL do corpo, porque o header
  // pode faltar ou mentir.
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "payload muito grande" }, { status: 413 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: "payload invalido" }, { status: 400 });
  }
  // Bytes reais do corpo (UTF-8), nao caracteres — content-length conta bytes.
  if (Buffer.byteLength(raw, "utf8") > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "payload muito grande" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
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
    if (event) console.info(`[asaas-webhook] evento sem acao: ${event}`);
    return NextResponse.json({ received: true, ignored: event ?? null });
  }

  const paymentId = payment?.id ?? "";
  if (!paymentId) {
    console.warn(`[asaas-webhook] ${event} sem payment.id; ignorado.`);
    return NextResponse.json({ received: true, matched: false });
  }

  const orderId = Number(payment?.externalReference);
  if (!Number.isInteger(orderId)) {
    console.warn(`[asaas-webhook] ${event} sem externalReference numerico (payment ${paymentId}).`);
    return NextResponse.json({ received: true, matched: false });
  }

  // Valor do evento (reais) -> centavos, para conferir com o total do pedido.
  // Prevent IEEE 754 rounding errors: use .toFixed(2) before multiplying
  const valueCents = typeof payment?.value === "number"
    ? Math.round(parseFloat(payment.value.toFixed(2)) * 100)
    : null;
  const eventId = asaasEventId(paymentId, event ?? "");

  try {
    // Ledger + efeito + mark-processed na MESMA transacao (H3). Reprocessa enquanto
    // processed_at IS NULL; um evento ja concluido vira no-op (duplicate).
    const outcome = await prisma.$transaction(
      async (tx) => {
        const { firstTime } = await recordWebhookEvent(tx, {
          provider: ASAAS_PROVIDER,
          eventId,
          type: event ?? "",
          payload: (body ?? null) as never,
        });
        if (!firstTime && (await isWebhookEventProcessed(tx, ASAAS_PROVIDER, eventId))) {
          return { duplicate: true as const };
        }

        const result = await applyPaymentStatusTx(tx, orderId, status, {
          id: paymentId,
          valueCents,
        });
        await markWebhookEventProcessed(tx, ASAAS_PROVIDER, eventId);
        return { duplicate: false as const, result };
      },
      { timeout: 15000, maxWait: 5000 },
    );

    if (outcome.duplicate) {
      console.info(`[asaas-webhook] evento ${eventId} ja processado (reenvio).`);
      return NextResponse.json({ received: true, duplicate: true });
    }

    const { result } = outcome;
    if (!result.found) {
      console.warn(`[asaas-webhook] pedido #${orderId} nao encontrado (evento ${event}).`);
      // Alerta admin FORA da transacao: o evento foi confirmado/deduplicado, o
      // Asaas nao reenvia — sem alerta a cobranca orfa some no console.warn.
      // try/catch como no e-mail de confirmacao: alerta nunca vira 500/reenvio.
      try {
        await sendWebhookRejectionAlertEmail({
          orderId: null,
          paymentId,
          event: event ?? "",
          reason: "order_not_found",
        });
      } catch (mailErr) {
        console.error(
          "[asaas-webhook] falha ao alertar rejeicao:",
          mailErr instanceof Error ? mailErr.message : mailErr,
        );
      }
      return NextResponse.json({ received: true, matched: false });
    }
    if (!result.ok) {
      console.warn(
        `[asaas-webhook] evento ${event} rejeitado p/ pedido #${orderId}: ${result.reason}.`,
      );
      // Idem: rejeicao de correlacao (valor/cobranca/transicao) e terminal para
      // este evento; o admin precisa saber que o pedido pode ter ficado 'pending'.
      try {
        await sendWebhookRejectionAlertEmail({
          orderId,
          paymentId,
          event: event ?? "",
          reason: result.reason,
        });
      } catch (mailErr) {
        console.error(
          "[asaas-webhook] falha ao alertar rejeicao:",
          mailErr instanceof Error ? mailErr.message : mailErr,
        );
      }
      return NextResponse.json({ received: true, verified: false });
    }
    if (!result.changed) {
      console.info(`[asaas-webhook] pedido #${orderId} ja estava "${status}" (evento ${event}).`);
    }

    // Pagamento recem-confirmado: dispara o e-mail (mock-first: no-op sem Resend).
    // FORA da transacao para que falha de e-mail nao force rollback/reenvio.
    // applyPaymentStatusTx ja devolve o pedido completo (mesma leitura), sem
    // getOrderById extra.
    if (result.changed && status === "paid") {
      try {
        await sendPaymentConfirmationEmail(result.order);
      } catch (mailErr) {
        console.error(
          "[asaas-webhook] falha ao enviar e-mail de pagamento:",
          mailErr instanceof Error ? mailErr.message : mailErr,
        );
      }
    }

    return NextResponse.json({ received: true, orderId, status, changed: result.changed });
  } catch (err) {
    // Erro transitorio: 500 p/ o Asaas reenviar. Como ledger + efeito sao a MESMA
    // transacao (que fez rollback), o reenvio reprocessa com seguranca.
    console.error(
      "[asaas-webhook] falha ao atualizar pedido:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "falha interna" }, { status: 500 });
  }
}

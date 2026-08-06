import { Prisma } from "../generated/prisma/client";
import { prisma } from "../db";

/**
 * Ledger de eventos de webhook (FUNDACAO) — camada ADICIONAL ao anti-replay por
 * asaasPaymentId que ja existe em setOrderPaymentStatus. (provider, eventId) e
 * unico, entao reprocessar o mesmo evento vira no-op.
 *
 * Semantica at-least-once correta: recordWebhookEvent (sem processed_at) +
 * efeito + markWebhookEventProcessed na MESMA transacao. Reprocessar e seguro
 * enquanto processed_at IS NULL (crash entre registrar e aplicar nao perde o efeito).
 */

/** provider canonico do Asaas. */
export const ASAAS_PROVIDER = "asaas";
/** provider canonico do Clerk. */
export const CLERK_PROVIDER = "clerk";
/**
 * provider dos ALERTAS da reconciliacao. A rejeicao de correlacao no reconcile
 * (ex.: value_mismatch) reincide a cada ciclo do cron; o ledger deduplica o
 * alerta admin (1x por (cobranca, motivo)) sem precisar de tabela nova.
 */
export const RECONCILE_ALERT_PROVIDER = "reconcile-alert";
/**
 * provider das FALHAS de cotacao do SuperFrete (nao e webhook — reusa o ledger
 * como log estruturado append-only pra nao precisar de tabela/migration nova;
 * mesmo principio do RECONCILE_ALERT_PROVIDER acima). Ver recordSuperfreteFailure.
 */
export const SUPERFRETE_FAILURE_PROVIDER = "superfrete-failure";

export type RecordWebhookEventInput = {
  provider: string;
  eventId: string;
  type: string;
  payload?: Prisma.InputJsonValue | null;
};

/**
 * Registra o evento no ledger (INSERT ... ON CONFLICT DO NOTHING via skipDuplicates).
 * - firstTime=true  => evento novo nesta transacao (processar efeitos).
 * - firstTime=false => ja existia; cabe ao chamador checar processed_at para
 *   decidir entre no-op (ja concluido) e reprocessar (ainda pendente).
 */
export async function recordWebhookEvent(
  tx: Prisma.TransactionClient,
  input: RecordWebhookEventInput,
): Promise<{ firstTime: boolean }> {
  const res = await tx.webhookEvent.createMany({
    data: [
      {
        provider: input.provider,
        eventId: input.eventId,
        type: input.type,
        payload: input.payload ?? Prisma.DbNull,
      },
    ],
    skipDuplicates: true,
  });
  return { firstTime: res.count > 0 };
}

/** true se o evento ja foi concluido (processed_at != null) — reprocessamento = no-op. */
export async function isWebhookEventProcessed(
  tx: Prisma.TransactionClient,
  provider: string,
  eventId: string,
): Promise<boolean> {
  const row = await tx.webhookEvent.findUnique({
    where: { provider_eventId: { provider, eventId } },
    select: { processedAt: true },
  });
  return Boolean(row?.processedAt);
}

/**
 * Marca o evento como concluido (processed_at = now()). Chamado ao final do
 * processamento bem-sucedido, DENTRO da mesma transacao dos efeitos.
 */
export async function markWebhookEventProcessed(
  tx: Prisma.TransactionClient,
  provider: string,
  eventId: string,
): Promise<void> {
  await tx.webhookEvent.updateMany({
    where: { provider, eventId },
    data: { processedAt: new Date() },
  });
}

/** Uma falha de cotacao do SuperFrete, para diagnostico posterior (nao e webhook). */
export type SuperfreteFailureInput = {
  /** Id de correlacao com o log [superfrete] (client.ts) — chave do ledger. */
  requestId: string;
  /** CEP de destino (dimensional — mesma informacao ja gravada em orders.address_cep). */
  toCep?: string;
  /** Texto do erro (ex.: "HTTP 504 (requestId ...)"). */
  detail?: string;
  /** Estado do circuit breaker (closed/open/half_open) NO MOMENTO desta falha. */
  circuitState?: string;
  /** Contagem de falhas do circuito apos esta (ver superfrete/circuitBreaker.ts). */
  circuitFailureCount?: number;
};

/**
 * Registra uma falha de cotacao do SuperFrete pra permitir diagnostico depois
 * (frequencia, destino, correlacao com o requestId do log). Reusa o ledger de
 * webhook_events como log estruturado append-only — SUPERFRETE_FAILURE_PROVIDER
 * nao e um webhook de verdade, mas (provider, eventId=requestId) e uma chave
 * unica igualmente valida aqui, e evita criar tabela/migration so pra isso.
 *
 * Best-effort por design: SEM try/catch aqui de proposito — o chamador (ver
 * carrinho/actions.ts, reportQuoteFallback) decide como tolerar a falha (o
 * mesmo padrao dos e-mails de alerta: nunca deve derrubar o checkout).
 */
export async function recordSuperfreteFailure(input: SuperfreteFailureInput): Promise<void> {
  await recordWebhookEvent(prisma, {
    provider: SUPERFRETE_FAILURE_PROVIDER,
    eventId: input.requestId,
    type: "provider_error",
    payload: {
      toCep: input.toCep ?? null,
      detail: input.detail ?? null,
      circuitState: input.circuitState ?? null,
      circuitFailureCount: input.circuitFailureCount ?? null,
    } as Prisma.InputJsonValue,
  });
}

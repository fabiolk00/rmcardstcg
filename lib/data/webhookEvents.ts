import { Prisma } from "../generated/prisma/client";

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

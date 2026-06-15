import { prisma } from "../db";

/**
 * Leitura para a reconciliacao de pagamentos (job pg_cron -> rota interna).
 *
 * Arquivo separado de orders.ts de proposito (evita conflito de edicao e mantem
 * a escrita concentrada em setOrderPaymentStatus, que detem o anti-replay/CAS).
 */

/** Pedido candidato a reconciliacao (pending + com cobranca Asaas vinculada). */
export type ReconcileCandidate = { id: number; asaasPaymentId: string };

/**
 * Pedidos 'pending' com asaasPaymentId, criados ha mais de `minAgeMinutes` (para
 * nao competir com o webhook que costuma chegar em segundos). Apenas leitura — a
 * escrita continua passando por setOrderPaymentStatus (anti-replay/value-check).
 */
export async function getPendingOrdersForReconciliation(opts: {
  minAgeMinutes: number;
  limit: number;
}): Promise<ReconcileCandidate[]> {
  const cutoff = new Date(Date.now() - opts.minAgeMinutes * 60_000);
  const rows = await prisma.order.findMany({
    where: {
      paymentStatus: "pending",
      asaasPaymentId: { not: null },
      createdAt: { lt: cutoff },
    },
    select: { id: true, asaasPaymentId: true },
    orderBy: { createdAt: "asc" },
    take: opts.limit,
  });
  return rows
    .filter((r): r is { id: number; asaasPaymentId: string } => r.asaasPaymentId !== null)
    .map((r) => ({ id: r.id, asaasPaymentId: r.asaasPaymentId }));
}

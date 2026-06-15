import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { getOrderById, setOrderPaymentStatus } from "@/lib/data/orders";
import { getPendingOrdersForReconciliation } from "@/lib/data/reconciliation";
import type { PaymentStatus } from "@/lib/data/types";
import { isAsaasConfigured } from "@/lib/services/asaas/config";
import { getPayment, paymentEventToStatus } from "@/lib/services/asaas/payments";
import { sendPaymentConfirmationEmail } from "@/lib/services/resend";

// Prisma (driver adapter pg) exige runtime Node — nunca Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rota interna de RECONCILIACAO — chamada SO pelo job pg_cron
 * (rmcards-reconcile-pending-orders) via pg_net.http_post. Billing fica aqui (TS),
 * nunca no SQL: varremos pedidos pending antigos com asaasPaymentId e consultamos
 * o status real no Asaas, aplicando setOrderPaymentStatus (anti-replay por
 * payment.id + checagem de valor + conciliacao de estoque — sem duplicar o webhook).
 *
 * Como os candidatos sao SEMPRE pending, a reconciliacao nunca cancela um pedido
 * ja pago (esse fluxo, incluindo refund/restock, e do webhook) — fecha pgcron-H2.
 *
 * Seguranca: o pg_cron envia o segredo no header `x-cron-secret`, comparado em
 * tempo constante com CRON_RECONCILE_SECRET. Sem segredo no servidor -> 500;
 * segredo errado/ausente -> 401. Mock-first: sem Asaas configurado -> 200 no-op.
 */

const RECONCILE_BATCH = 50;
// Idade minima do pedido pending para reconciliar (evita corrida com o webhook).
const MIN_AGE_MINUTES = 30;

function secretMatches(received: string | null): boolean {
  const expected = process.env.CRON_RECONCILE_SECRET;
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!process.env.CRON_RECONCILE_SECRET) {
    console.error("[reconcile] CRON_RECONCILE_SECRET nao definido.");
    return NextResponse.json({ error: "reconciliacao nao configurada" }, { status: 500 });
  }
  if (!secretMatches(req.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "nao autorizado" }, { status: 401 });
  }

  // Mock-first: sem chave do Asaas nao da pra consultar — no-op seguro.
  if (!isAsaasConfigured()) {
    return NextResponse.json({ reconciled: 0, skipped: "asaas_not_configured" });
  }

  const candidates = await getPendingOrdersForReconciliation({
    minAgeMinutes: MIN_AGE_MINUTES,
    limit: RECONCILE_BATCH,
  });

  let changed = 0;
  let checked = 0;
  for (const c of candidates) {
    checked += 1;
    try {
      const payment = await getPayment(c.asaasPaymentId);
      const status: PaymentStatus | undefined = paymentEventToStatus(payment.status);
      if (!status || status === "pending") continue;

      // Prevent IEEE 754 rounding errors: use .toFixed(2) before multiplying
      const valueCents = Math.round(parseFloat(payment.value.toFixed(2)) * 100);
      const result = await setOrderPaymentStatus(c.id, status, { id: payment.id, valueCents });
      if (result.found && result.ok && result.changed) {
        changed += 1;
        // Espelha o efeito do webhook: e-mail de confirmacao em pagamento novo.
        if (status === "paid") {
          try {
            const order = await getOrderById(`#${c.id}`);
            if (order) await sendPaymentConfirmationEmail(order);
          } catch (mailErr) {
            console.error(
              "[reconcile] falha ao enviar e-mail de pagamento:",
              mailErr instanceof Error ? mailErr.message : mailErr,
            );
          }
        }
      }
    } catch (err) {
      // Falha em um pedido nao derruba o lote; o proximo ciclo do cron tenta de novo.
      console.error(
        `[reconcile] falha ao reconciliar pedido #${c.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json({ reconciled: changed, checked });
}

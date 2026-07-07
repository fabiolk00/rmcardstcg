import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prova do wiring de alertas na rota de reconciliacao (reconcile-orders):
//  - Pedido corrigido pending->paid -> alerta de WEBHOOK PERDIDO + e-mail de
//    confirmacao ao cliente; reconciled conta.
//  - Rejeicao de correlacao (value_mismatch) -> alerta de rejeicao com event
//    RECONCILE, deduplicado pelo ledger (firstTime=false = SEM alerta repetido,
//    mesmo com o cron reincidindo a cada ciclo).
//  - Asaas ainda pending -> nenhum alerta (nada a corrigir).
//  - result.changed=false (outro processo aplicou antes) -> SEM alerta de perdido.
//
// Sem DB: reconciliation/orders/webhookEvents/asaas/resend mockados.

const missedMock = vi.fn(async () => {});
const rejectionMock = vi.fn(async () => {});
const paidEmailMock = vi.fn(async () => {});
vi.mock("@/lib/services/resend", () => ({
  sendPaymentConfirmationEmail: paidEmailMock,
  sendWebhookMissedAlertEmail: missedMock,
  sendWebhookRejectionAlertEmail: rejectionMock,
}));

const candidatesMock = vi.fn();
vi.mock("@/lib/data/reconciliation", () => ({
  getPendingOrdersForReconciliation: candidatesMock,
}));

const setStatusMock = vi.fn();
vi.mock("@/lib/data/orders", () => ({
  setOrderPaymentStatus: setStatusMock,
}));

const recordMock = vi.fn(async () => ({ firstTime: true }));
const markMock = vi.fn(async () => {});
vi.mock("@/lib/data/webhookEvents", () => ({
  RECONCILE_ALERT_PROVIDER: "reconcile-alert",
  recordWebhookEvent: recordMock,
  markWebhookEventProcessed: markMock,
}));

const getPaymentMock = vi.fn();
vi.mock("@/lib/services/asaas/payments", () => ({
  getPayment: getPaymentMock,
  paymentEventToStatus: (s: string) =>
    s === "RECEIVED" ? "paid" : s === "PENDING" ? "pending" : undefined,
}));

vi.mock("@/lib/services/asaas/config", () => ({
  isAsaasConfigured: () => true,
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));

const SECRET = "test-cron-secret";

async function postReconcile() {
  const { POST } = await import("../../app/api/internal/reconcile-orders/route");
  const req = new Request("https://example.com/api/internal/reconcile-orders", {
    method: "POST",
    headers: { "x-cron-secret": SECRET },
  });
  return POST(req);
}

const ORDER = { id: 7, customerEmail: "cliente@x.test" };

describe("reconcile-orders — alertas de webhook perdido/rejeitado", () => {
  beforeEach(() => {
    process.env.CRON_RECONCILE_SECRET = SECRET;
    missedMock.mockClear();
    rejectionMock.mockClear();
    paidEmailMock.mockClear();
    setStatusMock.mockReset();
    recordMock.mockClear();
    recordMock.mockResolvedValue({ firstTime: true });
    markMock.mockClear();
    getPaymentMock.mockReset();
    candidatesMock.mockReset();
    candidatesMock.mockResolvedValue([{ id: 7, asaasPaymentId: "pay_lost" }]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("pedido corrigido pending->paid: alerta de webhook perdido + e-mail ao cliente", async () => {
    getPaymentMock.mockResolvedValue({ id: "pay_lost", status: "RECEIVED", value: 10 });
    setStatusMock.mockResolvedValue({ found: true, ok: true, changed: true, order: ORDER });

    const res = await postReconcile();
    await expect(res.json()).resolves.toEqual({ reconciled: 1, checked: 1 });

    expect(missedMock).toHaveBeenCalledWith({ orderId: 7, paymentId: "pay_lost", status: "paid" });
    expect(paidEmailMock).toHaveBeenCalledWith(ORDER);
    expect(rejectionMock).not.toHaveBeenCalled();
  });

  it("rejeicao (value_mismatch) inedita: alerta RECONCILE + marca no ledger", async () => {
    getPaymentMock.mockResolvedValue({ id: "pay_lost", status: "RECEIVED", value: 10 });
    setStatusMock.mockResolvedValue({ found: true, ok: false, reason: "value_mismatch" });

    const res = await postReconcile();
    await expect(res.json()).resolves.toEqual({ reconciled: 0, checked: 1 });

    expect(rejectionMock).toHaveBeenCalledWith({
      orderId: 7,
      paymentId: "pay_lost",
      event: "RECONCILE",
      reason: "value_mismatch",
    });
    expect(recordMock).toHaveBeenCalledWith(expect.anything(), {
      provider: "reconcile-alert",
      eventId: "pay_lost|value_mismatch",
      type: "rejection_alert",
    });
    expect(markMock).toHaveBeenCalledWith(expect.anything(), "reconcile-alert", "pay_lost|value_mismatch");
    expect(missedMock).not.toHaveBeenCalled();
  });

  it("rejeicao repetida (ja no ledger): SEM alerta — cron nao spamma", async () => {
    getPaymentMock.mockResolvedValue({ id: "pay_lost", status: "RECEIVED", value: 10 });
    setStatusMock.mockResolvedValue({ found: true, ok: false, reason: "value_mismatch" });
    recordMock.mockResolvedValue({ firstTime: false });

    await postReconcile();

    expect(rejectionMock).not.toHaveBeenCalled();
    expect(markMock).not.toHaveBeenCalled();
  });

  it("Asaas ainda pending: nenhum alerta, nada a corrigir", async () => {
    getPaymentMock.mockResolvedValue({ id: "pay_lost", status: "PENDING", value: 10 });

    const res = await postReconcile();
    await expect(res.json()).resolves.toEqual({ reconciled: 0, checked: 1 });

    expect(setStatusMock).not.toHaveBeenCalled();
    expect(missedMock).not.toHaveBeenCalled();
    expect(rejectionMock).not.toHaveBeenCalled();
  });

  it("changed=false (webhook aplicou primeiro): SEM alerta de perdido", async () => {
    getPaymentMock.mockResolvedValue({ id: "pay_lost", status: "RECEIVED", value: 10 });
    setStatusMock.mockResolvedValue({ found: true, ok: true, changed: false, order: ORDER });

    const res = await postReconcile();
    await expect(res.json()).resolves.toEqual({ reconciled: 0, checked: 1 });

    expect(missedMock).not.toHaveBeenCalled();
    expect(paidEmailMock).not.toHaveBeenCalled();
  });

  it("alerta de perdido que LANCA nao derruba o lote (reconciled segue 1)", async () => {
    getPaymentMock.mockResolvedValue({ id: "pay_lost", status: "RECEIVED", value: 10 });
    setStatusMock.mockResolvedValue({ found: true, ok: true, changed: true, order: ORDER });
    missedMock.mockRejectedValueOnce(new Error("smtp down"));

    const res = await postReconcile();
    await expect(res.json()).resolves.toEqual({ reconciled: 1, checked: 1 });
  });
});

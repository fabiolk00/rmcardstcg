import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prova do wiring do alerta admin na rota do webhook Asaas:
//  - Rejeicao de correlacao (value_mismatch etc.) -> 200 {verified:false} + alerta
//    com orderId/paymentId/evento/motivo.
//  - Pedido nao encontrado -> 200 {matched:false} + alerta com orderId null e
//    reason "order_not_found".
//  - Sucesso -> SEM alerta (so o e-mail de confirmacao ao cliente).
//  - Duplicate (reenvio do Asaas) -> SEM alerta (nao ha spam: 1 alerta por evento).
//  - Alerta que LANCA nao muda a resposta 2xx (try/catch na rota).
//
// Sem DB: prisma.$transaction vira um executor do callback com tx dummy, e o
// efeito (applyPaymentStatusTx) e o ledger sao mockados.

const alertMock = vi.fn(async () => {});
const paidEmailMock = vi.fn(async () => {});
vi.mock("@/lib/services/resend", () => ({
  sendPaymentConfirmationEmail: paidEmailMock,
  sendWebhookRejectionAlertEmail: alertMock,
}));

const applyMock = vi.fn();
vi.mock("@/lib/data/orders", () => ({
  applyPaymentStatusTx: applyMock,
}));

const recordMock = vi.fn(async () => ({ firstTime: true }));
const processedMock = vi.fn(async () => false);
vi.mock("@/lib/data/webhookEvents", () => ({
  ASAAS_PROVIDER: "asaas",
  recordWebhookEvent: recordMock,
  isWebhookEventProcessed: processedMock,
  markWebhookEventProcessed: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  },
}));

const TOKEN = "test-asaas-webhook-token";

async function postEvent(body: unknown) {
  const { POST } = await import("../../app/api/webhooks/asaas/route");
  const req = new Request("https://example.com/api/webhooks/asaas", {
    method: "POST",
    headers: { "asaas-access-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req);
}

const RECEIVED = {
  event: "PAYMENT_RECEIVED",
  payment: { id: "pay_abc", externalReference: "42", value: 10 },
};

describe("webhook Asaas — alerta admin em rejeicao", () => {
  beforeEach(() => {
    process.env.ASAAS_WEBHOOK_TOKEN = TOKEN;
    alertMock.mockClear();
    paidEmailMock.mockClear();
    applyMock.mockReset();
    recordMock.mockClear();
    recordMock.mockResolvedValue({ firstTime: true });
    processedMock.mockClear();
    processedMock.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("value_mismatch -> 200 verified:false + alerta com pedido/cobranca/motivo", async () => {
    applyMock.mockResolvedValue({ found: true, ok: false, reason: "value_mismatch" });

    const res = await postEvent(RECEIVED);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, verified: false });

    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledWith({
      orderId: 42,
      paymentId: "pay_abc",
      event: "PAYMENT_RECEIVED",
      reason: "value_mismatch",
    });
    expect(paidEmailMock).not.toHaveBeenCalled();
  });

  it("pedido nao encontrado -> 200 matched:false + alerta order_not_found", async () => {
    applyMock.mockResolvedValue({ found: false });

    const res = await postEvent(RECEIVED);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, matched: false });

    expect(alertMock).toHaveBeenCalledWith({
      orderId: null,
      paymentId: "pay_abc",
      event: "PAYMENT_RECEIVED",
      reason: "order_not_found",
    });
  });

  it("sucesso (paid, changed) -> SEM alerta; e-mail de confirmacao segue", async () => {
    const order = { id: 42, customerEmail: "cliente@x.test" };
    applyMock.mockResolvedValue({ found: true, ok: true, changed: true, order });

    const res = await postEvent(RECEIVED);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: true, orderId: 42 });

    expect(alertMock).not.toHaveBeenCalled();
    expect(paidEmailMock).toHaveBeenCalledWith(order);
  });

  it("reenvio (duplicate no ledger) -> SEM alerta (1 alerta por evento, sem spam)", async () => {
    recordMock.mockResolvedValue({ firstTime: false });
    processedMock.mockResolvedValue(true);

    const res = await postEvent(RECEIVED);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, duplicate: true });

    expect(applyMock).not.toHaveBeenCalled();
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("alerta que LANCA nao derruba a resposta (segue 200 verified:false)", async () => {
    applyMock.mockResolvedValue({ found: true, ok: false, reason: "payment_mismatch" });
    alertMock.mockRejectedValueOnce(new Error("smtp down"));

    const res = await postEvent(RECEIVED);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true, verified: false });
  });
});

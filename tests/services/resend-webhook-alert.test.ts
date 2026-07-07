import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prova do alerta admin de webhook rejeitado (sendWebhookRejectionAlertEmail):
//  1. Mock-first: sem RESEND_API_KEY/RESEND_FROM_EMAIL ou sem ADMIN_EMAILS -> no-op.
//  2. Configurado: envia para TODOS os admins com evento/cobranca/pedido/motivo.
//  3. Tolerante a falha: erro do Resend e ENGOLIDO (a promise resolve) — o
//     webhook nunca vira 500 por causa de e-mail.
//
// Sem DB e sem rede: o pacote "resend" e substituido por um stub.

const sendMock = vi.fn(async () => ({ error: null as { message: string } | null }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

// O modulo importa @/emails/OrderEmail (JSX) para os e-mails de pedido; este
// teste so exercita o alerta (texto puro), entao o template vira stub.
vi.mock("@/emails/OrderEmail", () => ({ default: () => null }));

async function importService() {
  return import("../../lib/services/resend");
}

const ALERT = {
  orderId: 42,
  paymentId: "pay_abc",
  event: "PAYMENT_RECEIVED",
  reason: "value_mismatch",
};

describe("sendWebhookRejectionAlertEmail — alerta admin mock-first", () => {
  beforeEach(() => {
    sendMock.mockClear();
    sendMock.mockResolvedValue({ error: null });
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM_EMAIL = "loja@rmcards.test";
    process.env.ADMIN_EMAILS = "admin1@rmcards.test, admin2@rmcards.test";
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.ADMIN_EMAILS;
    vi.resetModules();
  });

  it("sem RESEND_API_KEY e no-op (mock-first)", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendWebhookRejectionAlertEmail } = await importService();
    await sendWebhookRejectionAlertEmail(ALERT);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sem ADMIN_EMAILS e no-op (nao ha destinatario)", async () => {
    delete process.env.ADMIN_EMAILS;
    const { sendWebhookRejectionAlertEmail } = await importService();
    await sendWebhookRejectionAlertEmail(ALERT);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("configurado: envia para todos os admins com o contexto da rejeicao", async () => {
    const { sendWebhookRejectionAlertEmail } = await importService();
    await sendWebhookRejectionAlertEmail(ALERT);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [payload] = sendMock.mock.calls[0] as unknown as [
      { to: string[]; subject: string; text: string; from: string },
    ];
    expect(payload.to).toEqual(["admin1@rmcards.test", "admin2@rmcards.test"]);
    expect(payload.subject).toContain("pedido #42");
    expect(payload.text).toContain("PAYMENT_RECEIVED");
    expect(payload.text).toContain("pay_abc");
    expect(payload.text).toContain("value_mismatch");
  });

  it("pedido nao encontrado: assunto e corpo dizem isso (orderId null)", async () => {
    const { sendWebhookRejectionAlertEmail } = await importService();
    await sendWebhookRejectionAlertEmail({ ...ALERT, orderId: null, reason: "order_not_found" });

    const [payload] = sendMock.mock.calls[0] as unknown as [{ subject: string; text: string }];
    expect(payload.subject).toContain("pedido não encontrado");
    expect(payload.text).toContain("order_not_found");
  });

  it("erro do Resend e engolido — a promise resolve (webhook nunca vira 500)", async () => {
    sendMock.mockRejectedValueOnce(new Error("boom"));
    const { sendWebhookRejectionAlertEmail } = await importService();
    await expect(sendWebhookRejectionAlertEmail(ALERT)).resolves.toBeUndefined();
  });

  it("error no retorno da API tambem nao propaga", async () => {
    sendMock.mockResolvedValueOnce({ error: { message: "invalid from" } });
    const { sendWebhookRejectionAlertEmail } = await importService();
    await expect(sendWebhookRejectionAlertEmail(ALERT)).resolves.toBeUndefined();
  });
});

describe("sendWebhookMissedAlertEmail — webhook perdido detectado pela reconciliacao", () => {
  const MISSED = { orderId: 7, paymentId: "pay_lost", status: "paid" };

  beforeEach(() => {
    sendMock.mockClear();
    sendMock.mockResolvedValue({ error: null });
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM_EMAIL = "loja@rmcards.test";
    process.env.ADMIN_EMAILS = "admin1@rmcards.test";
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.ADMIN_EMAILS;
    vi.resetModules();
  });

  it("sem config Resend e no-op (mock-first)", async () => {
    delete process.env.RESEND_API_KEY;
    const { sendWebhookMissedAlertEmail } = await importService();
    await sendWebhookMissedAlertEmail(MISSED);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("configurado: envia com pedido, cobranca e status aplicado", async () => {
    const { sendWebhookMissedAlertEmail } = await importService();
    await sendWebhookMissedAlertEmail(MISSED);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [payload] = sendMock.mock.calls[0] as unknown as [
      { to: string[]; subject: string; text: string },
    ];
    expect(payload.to).toEqual(["admin1@rmcards.test"]);
    expect(payload.subject).toContain("pedido #7");
    expect(payload.text).toContain("pay_lost");
    expect(payload.text).toContain('"paid"');
  });

  it("erro do Resend e engolido — a promise resolve", async () => {
    sendMock.mockRejectedValueOnce(new Error("boom"));
    const { sendWebhookMissedAlertEmail } = await importService();
    await expect(sendWebhookMissedAlertEmail(MISSED)).resolves.toBeUndefined();
  });
});

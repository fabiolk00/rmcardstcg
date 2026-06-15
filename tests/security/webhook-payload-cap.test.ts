import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prova do achado ⚪ "Webhook sem teto explicito de payload" (ITEM #5):
// o POST do webhook Asaas rejeita corpos acima de MAX_WEBHOOK_BYTES (256KB) com
// 413 ANTES de parsear/tocar o banco. Dois vetores:
//   1. Content-Length declarado acima do teto -> 413 (corte barato, sem ler corpo).
//   2. Content-Length AUSENTE/mentiroso mas corpo real grande -> 413 (defesa em
//      profundidade: o tamanho real do body tambem e checado).
// E os caminhos vizinhos seguem intactos: token invalido -> 401; JSON invalido
// dentro do teto -> 400.
//
// Sem DB: lib/db so LANCA se DATABASE_URL faltar e conecta de forma preguicosa,
// entao um valor dummy basta — o 413/401/400 retornam antes de qualquer query.

// O modulo da rota importa @/lib/services/resend, que por sua vez importa um
// template .tsx (JSX). Vitest nao transforma JSX com jsx:"preserve" do tsconfig,
// e este teste nao envia e-mail (so exercita o gate de tamanho/auth/parse), entao
// trocamos o servico por um stub no-op — mantendo a coleta sem DB nem React.
vi.mock("@/lib/services/resend", () => ({
  sendPaymentConfirmationEmail: vi.fn(async () => {}),
}));

const TOKEN = "test-asaas-webhook-token";

describe("webhook Asaas — teto de payload (Content-Length -> 413)", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://dummy:dummy@127.0.0.1:5432/dummy";
    process.env.ASAAS_WEBHOOK_TOKEN = TOKEN;
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function postWebhook(init: { headers: Record<string, string>; body: string }) {
    const { POST } = await import("../../app/api/webhooks/asaas/route");
    const req = new Request("https://example.com/api/webhooks/asaas", {
      method: "POST",
      headers: init.headers,
      body: init.body,
    });
    return POST(req);
  }

  it("rejeita com 413 quando Content-Length excede o teto (sem ler o corpo)", async () => {
    const res = await postWebhook({
      headers: {
        "asaas-access-token": TOKEN,
        "content-type": "application/json",
        // 1 MB declarado > 256KB. Corpo minusculo: o corte e pelo header.
        "content-length": String(1024 * 1024),
      },
      body: "{}",
    });
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "payload muito grande" });
  });

  it("rejeita com 413 quando o corpo REAL excede o teto mesmo sem Content-Length", async () => {
    // Sem header content-length: depende da checagem do tamanho real do body.
    const huge = `{"event":"PAYMENT_RECEIVED","pad":"${"x".repeat(300 * 1024)}"}`;
    const res = await postWebhook({
      headers: {
        "asaas-access-token": TOKEN,
        "content-type": "application/json",
      },
      body: huge,
    });
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "payload muito grande" });
  });

  it("token invalido continua 401 (teto nao mascara a autenticacao)", async () => {
    const res = await postWebhook({
      headers: {
        "asaas-access-token": "errado",
        "content-type": "application/json",
        "content-length": String(1024 * 1024),
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("JSON invalido dentro do teto continua 400 (parsing intacto)", async () => {
    const res = await postWebhook({
      headers: {
        "asaas-access-token": TOKEN,
        "content-type": "application/json",
      },
      body: "{ nao-e-json",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "payload invalido" });
  });

  it("payload pequeno e valido NAO e barrado pelo teto (evento sem acao -> 200)", async () => {
    // PAYMENT_OVERDUE nao mapeia para nenhum status: a rota responde 200 ignored
    // sem tocar o banco, provando que o corpo passou pelo gate de tamanho.
    const res = await postWebhook({
      headers: {
        "asaas-access-token": TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: "PAYMENT_OVERDUE", payment: { id: "pay_x" } }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ received: true });
  });
});

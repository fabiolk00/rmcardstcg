import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Politica de retry do asaasFetch (sem DB): GET idempotente re-tenta em 5xx/429;
// POST (cobranca) NUNCA re-tenta, para nao duplicar cliente/cobranca no Asaas.

describe("asaasFetch — retry só em métodos idempotentes", () => {
  beforeEach(() => {
    process.env.ASAAS_API_URL = "https://api-sandbox.asaas.com/v3";
    process.env.ASAAS_API_KEY = "test_key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("GET (getPayment) re-tenta em 503 e resolve", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) return new Response("", { status: 503 });
        return new Response(JSON.stringify({ id: "pay_1", status: "RECEIVED", value: 10 }), {
          status: 200,
        });
      }),
    );
    const { getPayment } = await import("../../lib/services/asaas/payments");
    const payment = await getPayment("pay_1");
    expect(payment.id).toBe("pay_1");
    expect(calls).toBe(3); // 2 falhas + 1 sucesso
  });

  it("POST (createPixCharge) NÃO re-tenta em 503 (evita cobrança duplicada)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(JSON.stringify({ errors: [{ description: "indisponível" }] }), {
          status: 503,
        });
      }),
    );
    const { createPixCharge } = await import("../../lib/services/asaas/payments");
    await expect(
      createPixCharge({
        customerId: "c_1",
        valueCents: 1000,
        externalReference: "1",
        dueDate: "2026-01-01",
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1); // sem re-tentativa
  });
});

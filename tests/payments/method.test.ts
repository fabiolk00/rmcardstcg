import { describe, expect, it } from "vitest";

import {
  dueDateForMethod,
  dueDaysForMethod,
  isValidPaymentMethod,
  normalizePaymentMethod,
  paymentBillingType,
  paymentMethodLabel,
  PAYMENT_METHODS,
} from "@/lib/payments/method";

// Dominio PURO do metodo de pagamento (pix | card à vista). Sem I/O — a data de
// vencimento recebe `now` injetado p/ ser deterministica.

describe("payments/method — dominio do metodo de pagamento", () => {
  it("PAYMENT_METHODS expoe apenas os slugs suportados (pix, card)", () => {
    expect([...PAYMENT_METHODS]).toEqual(["pix", "card"]);
  });

  it("isValidPaymentMethod: aceita so os slugs canonicos MINUSCULOS", () => {
    expect(isValidPaymentMethod("pix")).toBe(true);
    expect(isValidPaymentMethod("card")).toBe(true);
    // Case-sensitive: a validacao e estrita; a tolerancia de caixa vive no normalize.
    expect(isValidPaymentMethod("PIX")).toBe(false);
    expect(isValidPaymentMethod("Card")).toBe(false);
    expect(isValidPaymentMethod("boleto")).toBe(false);
    expect(isValidPaymentMethod("card_3x")).toBe(false);
    expect(isValidPaymentMethod("")).toBe(false);
    expect(isValidPaymentMethod(undefined)).toBe(false);
    expect(isValidPaymentMethod(42)).toBe(false);
  });

  it("normalizePaymentMethod: tolera caixa/espaco; invalido/ausente -> pix (default seguro)", () => {
    expect(normalizePaymentMethod("pix")).toBe("pix");
    expect(normalizePaymentMethod("card")).toBe("card");
    expect(normalizePaymentMethod("PIX")).toBe("pix");
    expect(normalizePaymentMethod("  Card  ")).toBe("card");
    expect(normalizePaymentMethod("CARD")).toBe("card");
    // Nao-suportado cai no default retrocompativel (checkout era PIX-only).
    expect(normalizePaymentMethod("boleto")).toBe("pix");
    expect(normalizePaymentMethod("card_3x")).toBe("pix");
    expect(normalizePaymentMethod("")).toBe("pix");
    expect(normalizePaymentMethod(undefined)).toBe("pix");
    expect(normalizePaymentMethod(null)).toBe("pix");
    expect(normalizePaymentMethod(123)).toBe("pix");
  });

  it("paymentBillingType: pix -> PIX; card -> CREDIT_CARD", () => {
    expect(paymentBillingType("pix")).toBe("PIX");
    expect(paymentBillingType("card")).toBe("CREDIT_CARD");
  });

  it("dueDaysForMethod: pix vence rapido (1d); card tem janela maior (3d)", () => {
    expect(dueDaysForMethod("pix")).toBe(1);
    expect(dueDaysForMethod("card")).toBe(3);
  });

  it("dueDateForMethod: soma os dias corretos a partir de `now` (deterministico)", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(dueDateForMethod("pix", now).toISOString().slice(0, 10)).toBe("2026-07-11");
    expect(dueDateForMethod("card", now).toISOString().slice(0, 10)).toBe("2026-07-13");
    // Nao muta o `now` recebido.
    expect(now.toISOString()).toBe("2026-07-10T12:00:00.000Z");
  });

  it("dueDateForMethod: atravessa virada de mes corretamente", () => {
    const now = new Date("2026-07-30T12:00:00.000Z");
    expect(dueDateForMethod("card", now).toISOString().slice(0, 10)).toBe("2026-08-02");
  });

  it("paymentMethodLabel: rotulo humano canonico + passthrough p/ legado/desconhecido", () => {
    expect(paymentMethodLabel("pix")).toBe("PIX");
    expect(paymentMethodLabel("card")).toBe("Cartão de crédito");
    expect(paymentMethodLabel("boleto")).toBe("Boleto");
    // Registro legado gravado com caixa alta (antes da padronizacao): passa como veio.
    expect(paymentMethodLabel("PIX")).toBe("PIX");
    expect(paymentMethodLabel("desconhecido")).toBe("desconhecido");
  });
});

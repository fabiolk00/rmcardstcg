import { describe, expect, it } from "vitest";

import { formatCep, paymentMethodLabel, shippingLabel } from "../../emails/orderEmailFormat";

// Helpers PUROS do template de e-mail (o .tsx em si nao roda no vitest — jsx
// "preserve"; a validacao visual e por render/screenshot fora daqui).

describe("orderEmailFormat — helpers puros do e-mail transacional", () => {
  it("formatCep: 8 digitos ganham hifen; fora disso passa como veio", () => {
    expect(formatCep("80000000")).toBe("80000-000");
    expect(formatCep("80000-000")).toBe("80000-000"); // ja formatado (re-normaliza)
    expect(formatCep("123")).toBe("123");
    expect(formatCep("")).toBe("");
  });

  it("paymentMethodLabel: pix/boleto/card viram rotulo humano; desconhecido passa", () => {
    expect(paymentMethodLabel("pix")).toBe("PIX");
    expect(paymentMethodLabel("boleto")).toBe("Boleto");
    expect(paymentMethodLabel("card")).toBe("Cartão de crédito");
    expect(paymentMethodLabel("berries")).toBe("berries");
    // Registro legado "PIX" (caixa alta, gravado por acaso antes da padronizacao)
    // segue exibindo certo pelo passthrough — nao regride ao adicionar o cartao.
    expect(paymentMethodLabel("PIX")).toBe("PIX");
  });

  it("shippingLabel: monta 'Frete', 'Frete (serviço)' e 'Frete (serviço — prazo)'", () => {
    expect(shippingLabel(null, null)).toBe("Frete");
    expect(shippingLabel(null, "5 a 8 dias úteis")).toBe("Frete"); // prazo sem serviço não aparece
    expect(shippingLabel("SEDEX", null)).toBe("Frete (SEDEX)");
    expect(shippingLabel("PAC", "5 a 8 dias úteis")).toBe("Frete (PAC — 5 a 8 dias úteis)");
  });
});

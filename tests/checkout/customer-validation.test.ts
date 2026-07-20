import { describe, expect, it } from "vitest";

import { validateCheckoutCustomer } from "@/lib/checkout/customer";

/**
 * T18 do documento de investigacao: o checkout NAO validava endereco no servidor —
 * so a UI. Uma chamada direta a server action criava pedido pago com CEP vazio, e a
 * falha so aparecia na emissao da etiqueta. Estes testes provam a validacao.
 */
const VALID = {
  name: "Fabio Kroker",
  email: "cliente@example.com",
  phone: "(41) 99999-9999",
  cpfCnpj: "123.456.789-09",
  cep: "80010-000",
  street: "Rua XV de Novembro, 100",
  city: "Curitiba",
  state: "PR",
};

describe("validateCheckoutCustomer", () => {
  it("aceita um cliente completo (com mascaras)", () => {
    expect(validateCheckoutCustomer(VALID)).toEqual({ ok: true });
  });

  it("aceita sem CPF/CNPJ (opcional no contrato mock-first)", () => {
    expect(validateCheckoutCustomer({ ...VALID, cpfCnpj: undefined })).toEqual({ ok: true });
    expect(validateCheckoutCustomer({ ...VALID, cpfCnpj: "" })).toEqual({ ok: true });
  });

  it("aceita CNPJ (14 digitos) e telefone fixo (10 digitos)", () => {
    expect(
      validateCheckoutCustomer({ ...VALID, cpfCnpj: "12.345.678/0001-95", phone: "4133334444" }),
    ).toEqual({ ok: true });
  });

  it.each([
    ["customer ausente", undefined, "customer"],
    ["nome vazio", { ...VALID, name: "   " }, "name"],
    ["e-mail sem @", { ...VALID, email: "cliente.example.com" }, "email"],
    ["e-mail sem TLD", { ...VALID, email: "cliente@example" }, "email"],
    ["telefone curto", { ...VALID, phone: "999" }, "phone"],
    ["CPF com 10 digitos", { ...VALID, cpfCnpj: "1234567890" }, "cpfCnpj"],
    ["CEP vazio", { ...VALID, cep: "" }, "cep"],
    ["CEP com 7 digitos", { ...VALID, cep: "8001000" }, "cep"],
    ["CEP nao-string", { ...VALID, cep: null as unknown as string }, "cep"],
    ["rua vazia", { ...VALID, street: "" }, "street"],
    ["cidade vazia", { ...VALID, city: "" }, "city"],
    ["UF com 3 letras", { ...VALID, state: "PRR" }, "state"],
    ["UF vazia", { ...VALID, state: "" }, "state"],
  ])("rejeita: %s", (_label, input, field) => {
    const res = validateCheckoutCustomer(input as never);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.field).toBe(field);
      expect(res.error.length).toBeGreaterThan(0);
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  formatCep,
  toInitialCustomer,
  type CustomerProfileLike,
} from "@/app/painel/checkout/prefill";

// Mapeamento PURO perfil (Conta) -> Form do checkout (contrato do
// app/painel/CONTRACT.md): campos 1:1 — rua, numero, complemento e bairro tem
// campo PROPRIO no checkout desde que a etiqueta passou a exigir numero e bairro
// separados (antes o mapeamento concatenava tudo em street). cep mascarado
// NNNNN-NNN, nulls viram "" (o form nao aceita null).

function profile(overrides: Partial<CustomerProfileLike> = {}): CustomerProfileLike {
  return {
    name: "Maria Colecionadora",
    email: "maria@exemplo.com",
    phone: "(41) 99999-0000",
    cpfCnpj: "52998224725",
    cep: "80010000",
    street: "Rua XV de Novembro",
    number: "285",
    complement: "Sala 3",
    district: "Centro",
    city: "Curitiba",
    state: "PR",
    ...overrides,
  };
}

describe("formatCep", () => {
  it("8 digitos sem mascara -> NNNNN-NNN", () => {
    expect(formatCep("80010000")).toBe("80010-000");
  });

  it("ja mascarado continua correto (re-normaliza)", () => {
    expect(formatCep("80010-000")).toBe("80010-000");
  });

  it("fora do formato (defensivo) volta como veio", () => {
    expect(formatCep("1234")).toBe("1234");
  });
});

describe("toInitialCustomer", () => {
  it("perfil completo: cada campo no seu campo; cep mascarado; 1:1 no resto", () => {
    expect(toInitialCustomer(profile())).toEqual({
      name: "Maria Colecionadora",
      email: "maria@exemplo.com",
      phone: "(41) 99999-0000",
      cpfCnpj: "52998224725",
      cep: "80010-000",
      street: "Rua XV de Novembro",
      number: "285",
      complement: "Sala 3",
      district: "Centro",
      city: "Curitiba",
      state: "PR",
    });
  });

  it("sem number: rua intacta e numero vazio (o checkout cobra o campo)", () => {
    const out = toInitialCustomer(profile({ number: null, complement: "Fundos" }));
    expect(out.street).toBe("Rua XV de Novembro");
    expect(out.number).toBe("");
    expect(out.complement).toBe("Fundos");
  });

  it("sem bairro no perfil: campo vazio (o checkout cobra)", () => {
    expect(toInitialCustomer(profile({ district: null })).district).toBe("");
  });

  it("nulls opcionais viram '' (o form do checkout nao aceita null)", () => {
    const out = toInitialCustomer(profile({ email: null, cpfCnpj: null }));
    expect(out.email).toBe("");
    expect(out.cpfCnpj).toBe("");
  });
});

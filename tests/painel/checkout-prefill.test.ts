import { describe, expect, it } from "vitest";

import {
  formatCep,
  toInitialCustomer,
  type CustomerProfileLike,
} from "@/app/painel/checkout/prefill";

// Mapeamento PURO perfil (Conta) -> Form do checkout (contrato do
// app/painel/CONTRACT.md): street composto com number/complement, cep mascarado
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
  it("perfil completo: street = rua + numero + complemento; cep mascarado; 1:1 no resto", () => {
    expect(toInitialCustomer(profile())).toEqual({
      name: "Maria Colecionadora",
      email: "maria@exemplo.com",
      phone: "(41) 99999-0000",
      cpfCnpj: "52998224725",
      cep: "80010-000",
      street: "Rua XV de Novembro, 285 Sala 3",
      city: "Curitiba",
      state: "PR",
    });
  });

  it("sem number: street puro (nao concatena virgula orfa nem complemento)", () => {
    const out = toInitialCustomer(profile({ number: null, complement: "Fundos" }));
    expect(out.street).toBe("Rua XV de Novembro");
  });

  it("com number e sem complement: rua + numero", () => {
    const out = toInitialCustomer(profile({ complement: null }));
    expect(out.street).toBe("Rua XV de Novembro, 285");
  });

  it("nulls opcionais viram '' (o form do checkout nao aceita null)", () => {
    const out = toInitialCustomer(profile({ email: null, cpfCnpj: null }));
    expect(out.email).toBe("");
    expect(out.cpfCnpj).toBe("");
  });
});

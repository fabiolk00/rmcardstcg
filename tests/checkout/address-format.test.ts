import { describe, expect, it } from "vitest";

import {
  formatAddressOneLine,
  formatCityLine,
  formatStreetLine,
} from "@/lib/data/address";
import type { OrderAddress } from "@/lib/data/types";

/**
 * Rua, numero, complemento e bairro viraram campos SEPARADOS (a etiqueta exige).
 * Quem exibisse so `street` passaria a mostrar endereco incompleto — e um pedido
 * de predio sem "apto 42" e uma entrega que nao acontece. Este formatador e a
 * fonte unica das telas de pedido, recibo e e-mail.
 */
const COMPLETO: OrderAddress = {
  cep: "80010000",
  street: "Rua XV de Novembro",
  number: "285",
  complement: "apto 42",
  district: "Centro",
  city: "Curitiba",
  state: "PR",
};

/** Pedido anterior a coleta dos campos novos: so tem rua. */
const LEGADO: OrderAddress = {
  cep: "80010000",
  street: "Rua XV de Novembro, 285",
  number: null,
  complement: null,
  district: null,
  city: "Curitiba",
  state: "PR",
};

describe("formatStreetLine", () => {
  it("junta rua, numero e complemento", () => {
    expect(formatStreetLine(COMPLETO)).toBe("Rua XV de Novembro, 285, apto 42");
  });

  it("sem complemento: so rua e numero", () => {
    expect(formatStreetLine({ ...COMPLETO, complement: null })).toBe("Rua XV de Novembro, 285");
  });

  it("pedido legado (sem numero): rua intacta, sem virgula orfa", () => {
    expect(formatStreetLine(LEGADO)).toBe("Rua XV de Novembro, 285");
  });

  it("campos so com espaco contam como ausentes", () => {
    expect(formatStreetLine({ ...COMPLETO, number: "  ", complement: "   " })).toBe(
      "Rua XV de Novembro",
    );
  });
});

describe("formatCityLine", () => {
  it("com bairro", () => {
    expect(formatCityLine(COMPLETO)).toBe("Centro — Curitiba/PR");
  });

  it("sem bairro (legado): so cidade/UF", () => {
    expect(formatCityLine(LEGADO)).toBe("Curitiba/PR");
  });
});

describe("formatAddressOneLine", () => {
  it("endereco de predio sai completo, com o apartamento", () => {
    expect(formatAddressOneLine(COMPLETO)).toBe(
      "Rua XV de Novembro, 285, apto 42 — Centro — Curitiba/PR",
    );
  });

  it("legado nao vira lixo com separadores vazios", () => {
    expect(formatAddressOneLine(LEGADO)).toBe("Rua XV de Novembro, 285 — Curitiba/PR");
  });
});

import { describe, expect, it } from "vitest";

import { formatDocument } from "@/lib/utils/document";

/**
 * O analitico do pedido exibe o CPF/CNPJ que o cliente digitou no checkout. O
 * dominio guarda so digitos; a mascara e da borda. Documento com tamanho
 * invalido NAO ganha mascara — precisa parecer errado para o admin.
 */
describe("formatDocument", () => {
  it("CPF (11 digitos) -> NNN.NNN.NNN-NN", () => {
    expect(formatDocument("52998224725")).toBe("529.982.247-25");
  });

  it("CNPJ (14 digitos) -> NN.NNN.NNN/NNNN-NN", () => {
    expect(formatDocument("12345678000195")).toBe("12.345.678/0001-95");
  });

  it("ja mascarado: normaliza a partir dos digitos", () => {
    expect(formatDocument("529.982.247-25")).toBe("529.982.247-25");
    expect(formatDocument("12.345.678/0001-95")).toBe("12.345.678/0001-95");
  });

  it("tamanho invalido devolve o valor cru (nao finge que esta certo)", () => {
    expect(formatDocument("1234567890")).toBe("1234567890");
    expect(formatDocument("abc")).toBe("abc");
  });

  it("null/vazio: null e string vazia passam direto", () => {
    expect(formatDocument(null)).toBeNull();
    expect(formatDocument(undefined)).toBeNull();
    expect(formatDocument("")).toBe("");
  });
});

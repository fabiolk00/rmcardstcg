/**
 * Validacao SERVER-SIDE dos dados do cliente no checkout.
 *
 * Por que existe: a UI ja exige os campos, mas server action e endpoint publico —
 * uma chamada direta criava pedido PAGO com endereco vazio/invalido. O erro so
 * aparecia depois, na emissao da etiqueta (labels.ts exige CEP de 8 digitos e
 * documento de 11/14), com o dinheiro ja cobrado e o estoque ja reservado.
 *
 * Regras deliberadamente MINIMAS (forma, nao existencia): checamos o que quebra o
 * fluxo de entrega/cobranca adiante — nao validamos se a rua existe nem digito
 * verificador de CPF. Puro (sem I/O) para ser testavel direto.
 */
export type CheckoutCustomerInput = {
  name: string;
  email: string;
  phone: string;
  cpfCnpj?: string;
  cep: string;
  street: string;
  /** Numero e bairro: exigidos pela transportadora para emitir a etiqueta. */
  number: string;
  complement?: string;
  district: string;
  city: string;
  state: string;
};

export type CustomerValidation = { ok: true } | { ok: false; field: string; error: string };

const digits = (s: unknown) => (typeof s === "string" ? s.replace(/\D/g, "") : "");
const text = (s: unknown) => (typeof s === "string" ? s.trim() : "");

// Forma de e-mail (nao RFC completa): algo@algo.tld sem espacos. O objetivo e
// barrar lixo obvio — a entrega real e provada pelo envio.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const UF_RE = /^[A-Za-z]{2}$/;

export function validateCheckoutCustomer(c: CheckoutCustomerInput | undefined): CustomerValidation {
  if (!c) return { ok: false, field: "customer", error: "Preencha seus dados de entrega." };

  if (text(c.name).length < 2) {
    return { ok: false, field: "name", error: "Informe seu nome completo." };
  }
  if (!EMAIL_RE.test(text(c.email))) {
    return { ok: false, field: "email", error: "Informe um e-mail válido." };
  }
  // Fixo (10) ou celular (11) com DDD.
  const phone = digits(c.phone);
  if (phone.length < 10 || phone.length > 11) {
    return { ok: false, field: "phone", error: "Informe um telefone válido com DDD." };
  }
  // CPF/CNPJ e opcional no contrato (mock-first), mas se vier tem que ter forma —
  // o Asaas recusa a cobranca com documento malformado.
  const doc = digits(c.cpfCnpj);
  if (text(c.cpfCnpj).length > 0 && doc.length !== 11 && doc.length !== 14) {
    return { ok: false, field: "cpfCnpj", error: "Informe um CPF ou CNPJ válido." };
  }
  if (digits(c.cep).length !== 8) {
    return { ok: false, field: "cep", error: "Informe um CEP válido (8 dígitos)." };
  }
  if (text(c.street).length < 3) {
    return { ok: false, field: "street", error: "Informe a rua do endereço de entrega." };
  }
  // Sem numero e bairro a transportadora recusa a etiqueta — barrar aqui evita
  // pedido pago que nao consegue ser despachado.
  if (text(c.number).length === 0) {
    return { ok: false, field: "number", error: "Informe o número do endereço." };
  }
  if (text(c.district).length < 2) {
    return { ok: false, field: "district", error: "Informe o bairro." };
  }
  if (text(c.city).length < 2) {
    return { ok: false, field: "city", error: "Informe a cidade." };
  }
  if (!UF_RE.test(text(c.state))) {
    return { ok: false, field: "state", error: "Informe o estado (UF com 2 letras)." };
  }
  return { ok: true };
}

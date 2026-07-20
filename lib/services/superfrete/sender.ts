import type { LabelAddress } from "./label-types";

/**
 * REMETENTE da loja (o "from" da etiqueta), por variavel de ambiente.
 *
 * A cotacao precisa so do CEP de origem (SUPERFRETE_FROM_CEP, ja existente); a
 * ETIQUETA precisa do endereco completo com CPF/CNPJ, numero e bairro — o
 * provedor rejeita sem eles. Fica em env pelo mesmo motivo do token: e
 * configuracao de ambiente, nao dado de catalogo, e a loja tem um remetente so.
 *
 * Mock-first como o resto: sem as variaveis, `senderAddress()` devolve null e
 * quem chama transforma isso numa mensagem clara ao admin em vez de estourar.
 */
export type SenderCheck =
  | { ok: true; sender: LabelAddress }
  | { ok: false; missing: string[]; error: string };

const digits = (s: string | undefined) => (s ?? "").replace(/\D/g, "");
const text = (s: string | undefined) => (s ?? "").trim();

/** Variaveis exigidas, na ordem em que aparecem na mensagem de erro. */
const REQUIRED = [
  "SUPERFRETE_FROM_NAME",
  "SUPERFRETE_FROM_DOCUMENT",
  "SUPERFRETE_FROM_ADDRESS",
  "SUPERFRETE_FROM_NUMBER",
  "SUPERFRETE_FROM_DISTRICT",
  "SUPERFRETE_FROM_CITY",
  "SUPERFRETE_FROM_STATE",
  "SUPERFRETE_FROM_CEP",
] as const;

/**
 * Monta o remetente a partir do ambiente. Valida FORMA (documento 11/14
 * digitos, CEP 8, UF 2 letras) alem da presenca: um remetente malformado so
 * falharia na chamada ao provedor, com mensagem tecnica que o admin nao entende.
 */
export function senderAddress(): SenderCheck {
  const missing = REQUIRED.filter((key) => text(process.env[key]).length === 0);
  if (missing.length > 0) {
    return {
      ok: false,
      missing: [...missing],
      error: `Remetente da loja não configurado. Faltam: ${missing.join(", ")}.`,
    };
  }

  const document = digits(process.env.SUPERFRETE_FROM_DOCUMENT);
  if (document.length !== 11 && document.length !== 14) {
    return {
      ok: false,
      missing: ["SUPERFRETE_FROM_DOCUMENT"],
      error: "CPF/CNPJ do remetente inválido (precisa de 11 ou 14 dígitos).",
    };
  }
  const postalCode = digits(process.env.SUPERFRETE_FROM_CEP);
  if (postalCode.length !== 8) {
    return {
      ok: false,
      missing: ["SUPERFRETE_FROM_CEP"],
      error: "CEP do remetente inválido (precisa de 8 dígitos).",
    };
  }
  const stateAbbr = text(process.env.SUPERFRETE_FROM_STATE).toUpperCase();
  if (!/^[A-Z]{2}$/.test(stateAbbr)) {
    return {
      ok: false,
      missing: ["SUPERFRETE_FROM_STATE"],
      error: "UF do remetente inválida (2 letras, ex.: PR).",
    };
  }

  return {
    ok: true,
    sender: {
      name: text(process.env.SUPERFRETE_FROM_NAME),
      document,
      address: text(process.env.SUPERFRETE_FROM_ADDRESS),
      number: text(process.env.SUPERFRETE_FROM_NUMBER),
      complement: text(process.env.SUPERFRETE_FROM_COMPLEMENT) || undefined,
      district: text(process.env.SUPERFRETE_FROM_DISTRICT),
      city: text(process.env.SUPERFRETE_FROM_CITY),
      stateAbbr,
      postalCode,
      email: text(process.env.SUPERFRETE_FROM_EMAIL) || undefined,
      phone: digits(process.env.SUPERFRETE_FROM_PHONE) || undefined,
    },
  };
}

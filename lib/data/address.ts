import type { OrderAddress } from "./types";

/**
 * Formatacao do endereco de entrega — funcao PURA, fonte unica para todas as
 * telas (pedido do cliente, recibo, e-mail, admin).
 *
 * Existe porque rua, numero, complemento e bairro viraram campos SEPARADOS
 * quando a emissao de etiqueta passou a exigir isso: quem exibir so `street`
 * mostra um endereco incompleto. Pedidos legados nao tem os campos novos (null)
 * e continuam exibindo o que tem, sem virgula orfa.
 */

const has = (s: string | null | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** "Rua XV de Novembro, 285, apto 42" — logradouro com numero e complemento. */
export function formatStreetLine(address: OrderAddress): string {
  const parts = [address.street.trim()];
  if (has(address.number)) parts.push(address.number.trim());
  if (has(address.complement)) parts.push(address.complement.trim());
  return parts.join(", ");
}

/** "Centro — Curitiba/PR" — bairro (quando houver), cidade e UF. */
export function formatCityLine(address: OrderAddress): string {
  const city = `${address.city}/${address.state}`;
  return has(address.district) ? `${address.district.trim()} — ${city}` : city;
}

/** Endereco inteiro numa linha, para listas e e-mail. */
export function formatAddressOneLine(address: OrderAddress): string {
  return `${formatStreetLine(address)} — ${formatCityLine(address)}`;
}

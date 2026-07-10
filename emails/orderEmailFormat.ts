/**
 * Helpers PUROS do template de e-mail transacional (sem JSX — testaveis no
 * vitest, que nao transforma o .tsx do template; ver tests/services).
 */

/** CEP "80000000" -> "80000-000" (so para exibir; nao valida). */
export function formatCep(cep: string): string {
  const digits = cep.replace(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : cep;
}

// Rotulo do metodo de pagamento — fonte unica no dominio de pagamento (usado
// tambem pelo checkout e telas de pedido), re-exportado aqui para o template.
export { paymentMethodLabel } from "@/lib/payments/method";

/**
 * Rotulo da linha de frete: "Frete", "Frete (SEDEX)" ou "Frete (SEDEX — 2 a 4
 * dias úteis)", conforme o que o pedido tiver.
 */
export function shippingLabel(service: string | null, days: string | null): string {
  if (!service) return "Frete";
  return days ? `Frete (${service} — ${days})` : `Frete (${service})`;
}

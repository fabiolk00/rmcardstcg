/**
 * Helpers PUROS do template de e-mail transacional (sem JSX — testaveis no
 * vitest, que nao transforma o .tsx do template; ver tests/services).
 */

/** CEP "80000000" -> "80000-000" (so para exibir; nao valida). */
export function formatCep(cep: string): string {
  const digits = cep.replace(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : cep;
}

/** Rotulo humano do metodo de pagamento ("pix" -> "PIX"; desconhecido passa como veio). */
export function paymentMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    pix: "PIX",
    boleto: "Boleto",
    card: "Cartão de crédito",
  };
  return labels[method] ?? method;
}

/**
 * Rotulo da linha de frete: "Frete", "Frete (SEDEX)" ou "Frete (SEDEX — 2 a 4
 * dias úteis)", conforme o que o pedido tiver.
 */
export function shippingLabel(service: string | null, days: string | null): string {
  if (!service) return "Frete";
  return days ? `Frete (${service} — ${days})` : `Frete (${service})`;
}

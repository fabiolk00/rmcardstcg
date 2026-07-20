import { FLAT_SHIPPING_CENTS, FREE_SHIPPING_THRESHOLD_CENTS } from "./totals";

/**
 * Regra de frete final (custo + free), 100% no servidor (a UI so reflete).
 *
 * - FREE: mercadoria 0 ou >= FREE_SHIPPING_THRESHOLD_CENTS (R$299) -> frete 0.
 * - CUSTO: abaixo do limiar -> o valor COTADO (SuperFrete). Sem cotacao
 *   (mock-first / indisponivel) cai no FLAT_SHIPPING_CENTS.
 *
 * Mantem a regra de frete gratis ja existente (lib/cart/totals) por cima da cotacao,
 * para o preco final unir os dois: cobra o transporte quando paga, zera quando livre.
 */
/**
 * Mensagem unica de "o provedor respondeu que NAO ha entrega" (cobertura, peso ou
 * medida). Diferente de "nao consegui cotar": aqui a venda e BLOQUEADA — aceitar o
 * pedido geraria uma etiqueta que nunca sai, com o dinheiro ja cobrado.
 */
export const SHIPPING_UNAVAILABLE_ERROR =
  "Não há entrega disponível para este CEP (região sem cobertura ou pacote acima do limite dos Correios). " +
  "Confira o CEP ou fale com a gente para combinarmos o envio.";

export function isFreeShipping(merchandiseCents: number): boolean {
  return merchandiseCents === 0 || merchandiseCents >= FREE_SHIPPING_THRESHOLD_CENTS;
}

export function resolveShippingCents(args: {
  merchandiseCents: number;
  /** Custo cotado (centavos) ou null quando nao ha cotacao. */
  quotedCents: number | null;
}): number {
  if (isFreeShipping(args.merchandiseCents)) return 0;
  return args.quotedCents ?? FLAT_SHIPPING_CENTS;
}

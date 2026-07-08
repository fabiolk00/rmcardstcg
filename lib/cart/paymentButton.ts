// Estado puro do botao de pagamento do checkout. O botao so libera o submit
// quando (frete calculado E termos aceitos); enquanto isso o rotulo explica o
// que falta. Logica extraida do CheckoutView para ser testavel sem render.

export type PaymentButtonState = "submitting" | "needShipping" | "needTerms" | "ready";

export interface PaymentButtonInput {
  /** submit em andamento (gerando PIX). */
  submitting: boolean;
  /** frete ja cotado para o CEP atual (free ou opcao escolhida). */
  shippingReady: boolean;
  /** total exibido ja calculado (depende do frete). */
  hasTotal: boolean;
  /** consentimento LGPD (Termos + Privacidade) marcado. */
  accepted: boolean;
}

// Ordem de precedencia: submetendo > falta frete > falta aceite > pronto.
// "needShipping" antes de "needTerms" porque o frete e a primeira barreira do
// fluxo (sem total nao ha o que pagar).
export function paymentButtonState(input: PaymentButtonInput): PaymentButtonState {
  if (input.submitting) return "submitting";
  if (!input.shippingReady || !input.hasTotal) return "needShipping";
  if (!input.accepted) return "needTerms";
  return "ready";
}

// So o estado "ready" habilita o clique.
export function isPaymentButtonDisabled(state: PaymentButtonState): boolean {
  return state !== "ready";
}

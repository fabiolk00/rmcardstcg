/**
 * Metodo de pagamento — dominio PURO (sem I/O), fonte unica de verdade para os
 * dois metodos suportados hoje: PIX e cartao de credito A VISTA.
 *
 * O `paymentMethod` do pedido e uma String livre no schema (sem enum/migration),
 * mas o codigo trata apenas os slugs canonicos MINUSCULOS abaixo. Registros
 * legados com outra grafia (ex.: "PIX" maiusculo, gravado por acaso antes deste
 * modulo) continuam sendo exibidos pelo passthrough de paymentMethodLabel.
 *
 * Sem parcelamento nesta versao: o cartao gera uma cobranca unica pelo valor
 * total (billingType CREDIT_CARD), entao o evento de confirmacao do Asaas traz
 * value == total e a verificacao de valor do webhook passa SEM alteracao.
 */

/** Slugs canonicos aceitos no checkout. */
export const PAYMENT_METHODS = ["pix", "card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Vencimento (dias a partir de hoje) por metodo — fonte do due_date do pedido. */
const DUE_DAYS: Record<PaymentMethod, number> = {
  // PIX expira rapido (QR de 1 dia).
  pix: 1,
  // Cartao e "customer-paced": o cliente abre a fatura hospedada do Asaas e pode
  // concluir depois. Janela maior evita que o expire_overdue_orders() (pg_cron,
  // que cancela cego sem consultar o Asaas) mate um pagamento legitimo em curso;
  // um cartao abandonado ainda libera o estoque em 3d + 60min de graca.
  card: 3,
};

/** billingType do Asaas por metodo. */
const BILLING_TYPE: Record<PaymentMethod, "PIX" | "CREDIT_CARD"> = {
  pix: "PIX",
  card: "CREDIT_CARD",
};

/** true se `value` e um slug de metodo suportado (pix | card). */
export function isValidPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * Normaliza a entrada do cliente para um slug canonico. Aceita variacoes de caixa
 * ("PIX", "Card"); qualquer coisa invalida/ausente cai em "pix" (default seguro e
 * retrocompativel — o checkout era PIX-only). NUNCA confia no client: o server
 * re-decide billingType/dueDate a partir deste slug.
 */
export function normalizePaymentMethod(value: unknown): PaymentMethod {
  if (typeof value === "string") {
    const slug = value.trim().toLowerCase();
    if (isValidPaymentMethod(slug)) return slug;
  }
  return "pix";
}

/** billingType do Asaas para o metodo (PIX | CREDIT_CARD). */
export function paymentBillingType(method: PaymentMethod): "PIX" | "CREDIT_CARD" {
  return BILLING_TYPE[method];
}

/** Quantos dias de vencimento o metodo usa (pix: 1, card: 3). */
export function dueDaysForMethod(method: PaymentMethod): number {
  return DUE_DAYS[method];
}

/**
 * Vencimento da cobranca (Date) por metodo, a partir de `now`. Fonte unica do
 * due_date do pedido (que alimenta o pg_cron de expiracao) e do dueDate enviado
 * ao Asaas. `now` e injetado para ser testavel de forma deterministica.
 */
export function dueDateForMethod(method: PaymentMethod, now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + dueDaysForMethod(method));
  return d;
}

/**
 * Rotulo humano do metodo de pagamento. Canonico: "pix" -> "PIX", "card" ->
 * "Cartao de credito". Mantem "boleto" e um passthrough para valores legados /
 * desconhecidos (ex.: "PIX" gravado com caixa alta antes da padronizacao).
 */
export function paymentMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    pix: "PIX",
    card: "Cartão de crédito",
    boleto: "Boleto",
  };
  return labels[method] ?? method;
}

import { asaasFetch } from "./client";

/**
 * Servico de cobrancas do Asaas — o que o checkout precisa para gerar um PIX.
 *
 * Fluxo: createCustomer (o Asaas cobra sempre um "customer") -> createPixCharge
 * (POST /payments com billingType PIX e externalReference = id do nosso pedido)
 * -> getPixQrCode (copia-e-cola + imagem do QR). O externalReference e o elo que
 * o webhook (app/api/webhooks/asaas) usa para achar o pedido de volta.
 *
 * Dinheiro: nosso dominio usa centavos (Int); o Asaas usa reais (decimal). A
 * conversao centavos -> reais acontece so na fronteira, aqui.
 */

export type AsaasCustomerInput = {
  name: string;
  email?: string;
  /** Telefone fixo. */
  phone?: string;
  /** Celular. */
  mobilePhone?: string;
  /** CPF ou CNPJ (so digitos). */
  cpfCnpj?: string;
};

export type AsaasCustomer = {
  id: string;
  name: string;
  email: string | null;
};

export type CreatePixChargeInput = {
  customerId: string;
  /** Valor total em centavos (convertido para reais aqui). */
  valueCents: number;
  /** Id do nosso pedido (ex.: "10421") — elo com o webhook. */
  externalReference: string;
  /** Vencimento da cobranca no formato YYYY-MM-DD. */
  dueDate: string;
  description?: string;
};

export type AsaasPayment = {
  id: string;
  status: string;
  value: number;
  billingType: string;
  externalReference: string | null;
  invoiceUrl: string;
  dueDate: string;
};

export type AsaasPixQrCode = {
  /** Imagem do QR em base64 (PNG). */
  encodedImage: string;
  /** Codigo copia-e-cola do PIX. */
  payload: string;
  /** Expiracao do QR (ISO). */
  expirationDate: string;
};

/** centavos -> reais com 2 casas (o Asaas rejeita mais de 2 decimais). */
function centsToReais(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

/** Cria (ou recria) um cliente no Asaas e devolve o id. */
export async function createCustomer(input: AsaasCustomerInput): Promise<AsaasCustomer> {
  return asaasFetch<AsaasCustomer>("/customers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Cria uma cobranca PIX com externalReference apontando para o pedido. */
export async function createPixCharge(input: CreatePixChargeInput): Promise<AsaasPayment> {
  return asaasFetch<AsaasPayment>("/payments", {
    method: "POST",
    body: JSON.stringify({
      customer: input.customerId,
      billingType: "PIX",
      value: centsToReais(input.valueCents),
      dueDate: input.dueDate,
      externalReference: input.externalReference,
      description: input.description,
    }),
  });
}

/** Busca o QR Code PIX (copia-e-cola + imagem) de uma cobranca. */
export async function getPixQrCode(paymentId: string): Promise<AsaasPixQrCode> {
  return asaasFetch<AsaasPixQrCode>(`/payments/${paymentId}/pixQrCode`);
}

/** Consulta uma cobranca pelo id (GET /payments/:id) — usado na reconciliacao. */
export async function getPayment(paymentId: string): Promise<AsaasPayment> {
  return asaasFetch<AsaasPayment>(`/payments/${paymentId}`);
}

/**
 * Mapeia o status de uma cobranca do Asaas (campo `status`, ex.: 'CONFIRMED',
 * 'RECEIVED', 'PENDING', 'REFUNDED') para o nosso modelo de 3 estados. Espelha a
 * tabela EVENT_TO_STATUS do webhook, mas para o status. undefined => sem acao.
 */
export function paymentEventToStatus(
  asaasStatus: string,
): "pending" | "paid" | "cancelled" | undefined {
  switch (asaasStatus) {
    case "CONFIRMED":
    case "RECEIVED":
    case "RECEIVED_IN_CASH":
      return "paid";
    case "REFUNDED":
    case "REFUND_REQUESTED":
    case "CHARGEBACK_REQUESTED":
    case "CHARGEBACK_DISPUTE":
    case "DELETED":
      return "cancelled";
    case "PENDING":
    case "AWAITING_RISK_ANALYSIS":
      return "pending";
    default:
      return undefined;
  }
}

import type { Order } from "@/lib/data/types";

/**
 * Que acoes de ETIQUETA a linha do pedido oferece — funcao PURA, para a regra
 * ficar testavel sem subir o admin (a tela exige login de admin, entao nao ha
 * cobertura e2e).
 *
 * A regra existe porque emitir etiqueta GASTA DINHEIRO: o botao so aparece
 * habilitado quando a emissao tem chance real de dar certo, e quando nao tem, a
 * linha diz o porque em vez de deixar o admin descobrir com um erro.
 */
export type OrderLabelState =
  | { kind: "issue"; disabled: false }
  | { kind: "issue"; disabled: true; reason: string }
  | { kind: "manage"; trackingCode: string | null }
  | { kind: "none" };

/** Status do provedor que significam "esta etiqueta nao vale mais". */
const DEAD = ["canceled", "cancelled"];

export function orderLabelState(order: Order): OrderLabelState {
  const label = order.shippingLabel;
  if (label && !DEAD.includes(label.status)) {
    return { kind: "manage", trackingCode: label.trackingCode };
  }

  // Envio terminal: nao ha o que despachar (entregue) nem faz sentido pagar
  // etiqueta de pedido cancelado.
  if (order.shippingStatus === "delivered" || order.shippingStatus === "cancelled") {
    return { kind: "none" };
  }
  if (order.paymentStatus !== "paid") {
    return { kind: "issue", disabled: true, reason: "Só para pedido pago" };
  }
  // Pedido anterior a coleta destes campos: a transportadora recusa sem eles, e
  // o admin precisa saber disso ANTES de clicar.
  if (!order.customerDocument) {
    return { kind: "issue", disabled: true, reason: "Pedido sem CPF/CNPJ" };
  }
  if (!order.address.number || !order.address.district) {
    return { kind: "issue", disabled: true, reason: "Endereço sem número/bairro" };
  }
  if (order.shippingServiceCode == null) {
    return { kind: "issue", disabled: true, reason: "Pedido sem modalidade cotada" };
  }
  return { kind: "issue", disabled: false };
}

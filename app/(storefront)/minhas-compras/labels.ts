import type { PaymentStatus, ShippingStatus } from "@/lib/data/types";

// Rotulos pt-BR dos status de pedido — compartilhados entre a lista (Minhas
// Compras) e a tela de detalhe, para nao divergirem.
export const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  paid: "Pago",
  pending: "Pendente",
  cancelled: "Cancelado",
};

export const SHIPPING_LABEL: Record<ShippingStatus, string> = {
  pending: "A enviar",
  sent: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado",
};

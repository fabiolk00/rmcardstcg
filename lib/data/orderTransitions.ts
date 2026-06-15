import type { ShippingStatus } from "./types";

/**
 * Maquina de transicao de ENVIO (fonte de verdade no server). Arquivo
 * CLIENT-SAFE de proposito: nao importa `prisma` nem nada server-only, para que
 * componentes client (OrderStatusModal) possam importar allowedShippingTransitions
 * sem arrastar o driver do banco para o bundle do navegador.
 *
 * pending -> sent -> delivered (linha feliz). Cancelar e possivel enquanto nao
 * entregue (de pending ou sent). 'delivered' e 'cancelled' sao terminais.
 */
export const SHIPPING_TRANSITIONS: Record<ShippingStatus, readonly ShippingStatus[]> = {
  pending: ["sent", "cancelled"],
  sent: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

/** Destinos validos de envio a partir do estado atual (consumido pela UI). */
export function allowedShippingTransitions(from: ShippingStatus): ShippingStatus[] {
  return [...SHIPPING_TRANSITIONS[from]];
}

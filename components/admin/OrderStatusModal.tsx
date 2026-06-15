"use client";

import { useState } from "react";
import type { Order, PaymentStatus, ShippingStatus } from "@/lib/data/types";
import { Modal } from "@/components/ui/Modal";
import styles from "./OrderStatusModal.module.css";

type Props = {
  order: Order;
  onClose: () => void;
  onSave: (id: string, payment: PaymentStatus, shipping: ShippingStatus) => void;
};

export function OrderStatusModal({ order, onClose, onSave }: Props) {
  const [payment, setPayment] = useState<PaymentStatus>(order.paymentStatus);
  const [shipping, setShipping] = useState<ShippingStatus>(order.shippingStatus);

  return (
    <Modal
      title="Atualizar status"
      sub={`Pedido ${order.id} — ${order.customerName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={() => onSave(order.id, payment, shipping)}
          >
            Salvar
          </button>
        </>
      }
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="os-pay">
          Pagamento
        </label>
        <select
          id="os-pay"
          className={styles.select}
          value={payment}
          onChange={(e) => setPayment(e.target.value as PaymentStatus)}
        >
          <option value="pending">Pendente</option>
          <option value="paid">Pago</option>
          <option value="cancelled">Cancelado</option>
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="os-ship">
          Envio
        </label>
        <select
          id="os-ship"
          className={styles.select}
          value={shipping}
          onChange={(e) => setShipping(e.target.value as ShippingStatus)}
        >
          <option value="pending">A enviar</option>
          <option value="sent">Enviado</option>
          <option value="delivered">Entregue</option>
          <option value="cancelled">Cancelado</option>
        </select>
      </div>
    </Modal>
  );
}

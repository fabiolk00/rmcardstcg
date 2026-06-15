"use client";

import { useState } from "react";
import type { Product } from "@/lib/data/types";
import { Modal } from "@/components/ui/Modal";
import styles from "./InactivateModal.module.css";

type Props = {
  product: Product;
  onClose: () => void;
  onConfirm: () => void;
};

export function InactivateModal({ product, onClose, onConfirm }: Props) {
  const [ack, setAck] = useState(false);
  return (
    <Modal
      title="Inativar produto"
      sub={product.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className={styles.confirm} onClick={onConfirm} disabled={!ack}>
            Inativar
          </button>
        </>
      }
    >
      <p id="inactivate-desc" className={styles.text}>
        O produto deixará de aparecer na loja. O histórico e os pedidos são mantidos, e você pode
        reativá-lo depois.
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          aria-describedby="inactivate-desc"
        />
        <span>Estou ciente de que o produto ficará indisponível na loja.</span>
      </label>
    </Modal>
  );
}

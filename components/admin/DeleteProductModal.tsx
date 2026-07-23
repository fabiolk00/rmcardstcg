"use client";

import { useState } from "react";
import type { Product } from "@/lib/data/types";
import { Modal } from "@/components/ui/Modal";
import { SpinnerLabel } from "@/components/ui/Spinner";
import styles from "./DeleteProductModal.module.css";

type Props = {
  product: Product;
  onClose: () => void;
  /** Retorna mensagem de erro p/ exibir, ou null em sucesso. */
  onConfirm: () => Promise<string | null>;
};

export function DeleteProductModal({ product, onClose, onConfirm }: Props) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!ack || busy) return;
    setBusy(true);
    setError(null);
    const err = await onConfirm();
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Modal
      title="Excluir produto"
      sub={product.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className={styles.danger} onClick={confirm} disabled={!ack || busy}>
            {busy ? <SpinnerLabel size={14}>Excluindo…</SpinnerLabel> : "Excluir"}
          </button>
        </>
      }
    >
      <p id="delete-product-desc" className={styles.text}>
        O produto <strong>{product.name}</strong> será removido <strong>permanentemente</strong> e não
        poderá ser recuperado. Um produto que já foi vendido não pode ser excluído — nesse caso,
        inative-o para tirá-lo da loja.
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          aria-describedby="delete-product-desc"
        />
        <span>Entendo que esta ação é permanente e não pode ser desfeita.</span>
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

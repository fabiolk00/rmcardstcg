"use client";

import { useState } from "react";
import type { Product } from "@/lib/data/types";
import { Modal } from "@/components/ui/Modal";
import styles from "./InactivateModal.module.css";

type Props = {
  product: Product;
  onClose: () => void;
  /** Retorna mensagem de erro p/ exibir, ou null em sucesso. */
  onConfirm: () => Promise<string | null>;
};

export function InactivateModal({ product, onClose, onConfirm }: Props) {
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
      title="Inativar produto"
      sub={product.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className={styles.confirm}
            onClick={confirm}
            disabled={!ack || busy}
          >
            {busy ? "Inativando…" : "Inativar"}
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
      {error && (
        <p className={styles.text} role="alert" style={{ color: "var(--red-strong)" }}>
          {error}
        </p>
      )}
    </Modal>
  );
}

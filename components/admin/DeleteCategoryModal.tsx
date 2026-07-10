"use client";

import { useState } from "react";
import type { Category } from "@/lib/data/categories";
import { Modal } from "@/components/ui/Modal";
import { SpinnerLabel } from "@/components/ui/Spinner";
import styles from "./DeleteCategoryModal.module.css";

type Props = {
  category: Category;
  onClose: () => void;
  /** Retorna mensagem de erro p/ exibir, ou null em sucesso. */
  onConfirm: () => Promise<string | null>;
};

export function DeleteCategoryModal({ category, onClose, onConfirm }: Props) {
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
      title="Excluir categoria"
      sub={category.name}
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
      <p id="delete-category-desc" className={styles.text}>
        A categoria <strong>{category.name}</strong> será removida <strong>permanentemente</strong> e
        não poderá ser recuperada.
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          aria-describedby="delete-category-desc"
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

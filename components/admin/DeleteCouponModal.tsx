"use client";

import { useState } from "react";
import type { Coupon } from "@/lib/data/coupons";
import { Modal } from "@/components/ui/Modal";
import { SpinnerLabel } from "@/components/ui/Spinner";
import styles from "./DeleteCouponModal.module.css";

type Props = {
  coupon: Coupon;
  onClose: () => void;
  /** Retorna mensagem de erro p/ exibir, ou null em sucesso. */
  onConfirm: () => Promise<string | null>;
};

export function DeleteCouponModal({ coupon, onClose, onConfirm }: Props) {
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
      title="Excluir cupom"
      sub={coupon.code}
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
      <p id="delete-coupon-desc" className={styles.text}>
        O cupom <strong>{coupon.code}</strong> será removido <strong>permanentemente</strong> e não
        poderá ser recuperado. Para apenas tirá-lo de circulação sem perder o histórico, prefira{" "}
        <strong>inativar</strong>.
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          aria-describedby="delete-coupon-desc"
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

"use client";

import { useMemo, useState } from "react";
import type { OrderActionResult } from "@/app/admin/pedidos/actions";
import { CARRIERS } from "@/lib/data/carriers";
import { allowedShippingTransitions } from "@/lib/data/orderTransitions";
import type { Order, PaymentStatus, ShippingStatus } from "@/lib/data/types";
import { Modal } from "@/components/ui/Modal";
import styles from "./OrderStatusModal.module.css";

const SHIP_LABEL: Record<ShippingStatus, string> = {
  pending: "A enviar",
  sent: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado",
};

type Handlers = {
  onShipping: (to: ShippingStatus) => Promise<OrderActionResult>;
  onPayment: (to: PaymentStatus, reason: string) => Promise<OrderActionResult>;
  onNote: (note: string) => Promise<OrderActionResult>;
  onTracking: (trackingCode: string, carrier: string) => Promise<OrderActionResult>;
};

type Props = {
  order: Order;
  onClose: () => void;
  /** Recebe o Order final (servidor e fonte de verdade) p/ o pai atualizar a lista. */
  onSaved: (order: Order) => void;
  handlers: Handlers;
};

export function OrderStatusModal({ order, onClose, onSaved, handlers }: Props) {
  const [payment, setPayment] = useState<PaymentStatus>(order.paymentStatus);
  const [shipping, setShipping] = useState<ShippingStatus>(order.shippingStatus);
  const [note, setNote] = useState<string>(order.internalNote ?? "");
  const [carrier, setCarrier] = useState<string>(order.shippingCarrier ?? "");
  const [trackingCode, setTrackingCode] = useState<string>(order.trackingCode ?? "");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Destinos de envio validos a partir do estado atual (+ o proprio, p/ "nao mudar").
  const shipOptions = useMemo<ShippingStatus[]>(
    () => [order.shippingStatus, ...allowedShippingTransitions(order.shippingStatus)],
    [order.shippingStatus],
  );

  const paymentChanged = payment !== order.paymentStatus;
  const shippingChanged = shipping !== order.shippingStatus;
  const noteChanged = (note.trim() || null) !== (order.internalNote ?? null);
  const trackingChanged =
    (trackingCode.trim() || null) !== (order.trackingCode ?? null) ||
    (carrier || null) !== (order.shippingCarrier ?? null);
  const dirty = paymentChanged || shippingChanged || noteChanged || trackingChanged;
  const needsReason = paymentChanged;

  async function handleSave() {
    setError(null);
    if (needsReason && reason.trim().length < 3) {
      setError("Ajuste manual de pagamento exige um motivo (mín. 3 caracteres).");
      return;
    }
    setSaving(true);
    let latest: Order = order;
    try {
      // Ordem: pagamento (com motivo) -> envio -> nota. Para no primeiro erro.
      if (paymentChanged) {
        const r = await handlers.onPayment(payment, reason);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        latest = r.order;
      }
      if (shippingChanged) {
        const r = await handlers.onShipping(shipping);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        latest = r.order;
      }
      if (noteChanged) {
        const r = await handlers.onNote(note);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        latest = r.order;
      }
      if (trackingChanged) {
        const r = await handlers.onTracking(trackingCode.trim(), carrier);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        latest = r.order;
      }
      onSaved(latest);
    } catch {
      setError("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Atualizar status"
      sub={`Pedido ${order.id} — ${order.customerName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button
            type="button"
            className={styles.primary}
            onClick={handleSave}
            disabled={saving || !dirty}
          >
            {saving ? "Salvando…" : "Salvar"}
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
          disabled={saving}
          onChange={(e) => setPayment(e.target.value as PaymentStatus)}
        >
          <option value="pending">Pendente</option>
          <option value="paid">Pago</option>
          <option value="cancelled">Cancelado</option>
        </select>
      </div>

      {needsReason && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="os-reason">
            Motivo do ajuste manual (obrigatório)
          </label>
          <input
            id="os-reason"
            className={styles.select}
            value={reason}
            disabled={saving}
            placeholder="Ex.: confirmado manualmente via comprovante PIX"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="os-ship">
          Envio
        </label>
        <select
          id="os-ship"
          className={styles.select}
          value={shipping}
          disabled={saving}
          onChange={(e) => setShipping(e.target.value as ShippingStatus)}
        >
          {shipOptions.map((s) => (
            <option key={s} value={s}>
              {SHIP_LABEL[s]}
              {s === order.shippingStatus ? " (atual)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="os-carrier">
          Transportadora
        </label>
        <select
          id="os-carrier"
          className={styles.select}
          value={carrier}
          disabled={saving}
          onChange={(e) => setCarrier(e.target.value)}
        >
          <option value="">— Não definida</option>
          {CARRIERS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="os-tracking">
          Código de rastreio
        </label>
        <input
          id="os-tracking"
          className={styles.select}
          value={trackingCode}
          disabled={saving}
          placeholder="Ex.: AA123456789BR"
          onChange={(e) => setTrackingCode(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="os-note">
          Nota interna
        </label>
        <textarea
          id="os-note"
          className={styles.select}
          rows={3}
          value={note}
          disabled={saving}
          placeholder="Visível apenas no admin"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

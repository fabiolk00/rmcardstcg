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

type LabelResult = { ok: true; order: Order; message: string } | { ok: false; error: string };
type PrintResult = { ok: true; url: string } | { ok: false; error: string };

type Handlers = {
  onShipping: (to: ShippingStatus) => Promise<OrderActionResult>;
  onPayment: (to: PaymentStatus, reason: string) => Promise<OrderActionResult>;
  onNote: (note: string) => Promise<OrderActionResult>;
  onTracking: (trackingCode: string, carrier: string) => Promise<OrderActionResult>;
  /** Emite a etiqueta no SuperFrete (PAGA com o saldo da carteira). */
  onIssueLabel: () => Promise<LabelResult>;
  onPrintLabel: (format: "A4" | "A6") => Promise<PrintResult>;
  onCancelLabel: () => Promise<LabelResult>;
};

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;

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
  // Etiqueta: estado proprio (a acao e imediata, nao entra no "Salvar").
  const [label, setLabel] = useState(order.shippingLabel);
  const [labelBusy, setLabelBusy] = useState(false);
  const [labelMsg, setLabelMsg] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

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

  async function handleIssue() {
    setLabelBusy(true);
    setLabelMsg(null);
    setError(null);
    try {
      const res = await handlers.onIssueLabel();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setLabel(res.order.shippingLabel);
      setLabelMsg(res.message);
      setShipping(res.order.shippingStatus);
      setTrackingCode(res.order.trackingCode ?? "");
      setCarrier(res.order.shippingCarrier ?? "");
      onSaved(res.order);
    } catch {
      setError("Não foi possível emitir a etiqueta. Tente novamente.");
    } finally {
      setLabelBusy(false);
    }
  }

  async function handlePrint(format: "A4" | "A6") {
    setLabelBusy(true);
    setLabelMsg(null);
    setError(null);
    try {
      const res = await handlers.onPrintLabel(format);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Abre o PDF em nova aba; se o navegador bloquear, o link fica na mensagem.
      window.open(res.url, "_blank", "noopener,noreferrer");
      setLabelMsg(`Etiqueta ${format} aberta em nova aba.`);
    } catch {
      setError("Não foi possível gerar o PDF da etiqueta.");
    } finally {
      setLabelBusy(false);
    }
  }

  /** Dois cliques: cancelar etiqueta paga vira credito, nao dinheiro de volta. */
  async function handleCancelLabel() {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setLabelBusy(true);
    setLabelMsg(null);
    setError(null);
    try {
      const res = await handlers.onCancelLabel();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setLabel(null);
      setLabelMsg(res.message);
      setTrackingCode(res.order.trackingCode ?? "");
      setCarrier(res.order.shippingCarrier ?? "");
      onSaved(res.order);
    } catch {
      setError("Não foi possível cancelar a etiqueta.");
    } finally {
      setLabelBusy(false);
      setConfirmCancel(false);
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
        <span className={styles.label}>Etiqueta de envio</span>
        {label && label.status !== "canceled" ? (
          <>
            <p className={styles.labelInfo}>
              Emitida por {brl(label.costCents)} — {label.status}
              {label.trackingCode ? ` · rastreio ${label.trackingCode}` : " · rastreio ainda não emitido"}
            </p>
            <div className={styles.labelActions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={labelBusy}
                onClick={() => handlePrint("A4")}
              >
                Imprimir A4
              </button>
              <button
                type="button"
                className={styles.secondary}
                disabled={labelBusy}
                onClick={() => handlePrint("A6")}
              >
                Imprimir A6
              </button>
              <button
                type="button"
                className={styles.secondary}
                disabled={labelBusy}
                onClick={handleCancelLabel}
              >
                {confirmCancel ? "Confirmar cancelamento" : "Cancelar etiqueta"}
              </button>
            </div>
            {confirmCancel && (
              <p className={styles.labelInfo}>
                O valor volta como crédito na carteira SuperFrete, não para a conta bancária.
              </p>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.secondary}
              disabled={labelBusy || order.paymentStatus !== "paid"}
              onClick={handleIssue}
            >
              {labelBusy ? "Emitindo…" : "Gerar etiqueta"}
            </button>
            <p className={styles.labelInfo}>
              {order.paymentStatus !== "paid"
                ? "Disponível só para pedido pago."
                : "Debita o saldo da carteira SuperFrete e preenche o rastreio."}
            </p>
          </>
        )}
        {labelMsg && <p className={styles.labelInfo}>{labelMsg}</p>}
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

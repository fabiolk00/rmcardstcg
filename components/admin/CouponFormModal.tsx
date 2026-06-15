"use client";

import { useState } from "react";
import type { Coupon } from "@/lib/data/coupons";
import type { CouponFormPayload } from "@/app/admin/cupons/actions";
import { Modal } from "@/components/ui/Modal";
import styles from "./CouponFormModal.module.css";

type Props = {
  /** null => criando; Coupon => editando. */
  coupon: Coupon | null;
  pending: boolean;
  onClose: () => void;
  onSave: (id: string | null, payload: CouponFormPayload) => void;
};

type CouponType = "percent" | "fixed";

/** Converte ISO -> valor de <input type=date> (YYYY-MM-DD). */
function toDateInput(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

export function CouponFormModal({ coupon, pending, onClose, onSave }: Props) {
  const isNew = coupon === null;
  const [code, setCode] = useState(coupon?.code ?? "");
  const [type, setType] = useState<CouponType>(coupon?.type ?? "percent");
  const [percentOff, setPercentOff] = useState(
    coupon?.percentOff != null ? String(coupon.percentOff) : "10",
  );
  const [valueReais, setValueReais] = useState(
    coupon?.valueCents != null ? (coupon.valueCents / 100).toFixed(2) : "",
  );
  const [minReais, setMinReais] = useState(
    coupon && coupon.minSubtotalCents > 0 ? (coupon.minSubtotalCents / 100).toFixed(2) : "",
  );
  const [maxRedemptions, setMaxRedemptions] = useState(
    coupon?.maxRedemptions != null ? String(coupon.maxRedemptions) : "",
  );
  const [perUserLimit, setPerUserLimit] = useState(
    coupon?.perUserLimit != null ? String(coupon.perUserLimit) : "",
  );
  const [startsAt, setStartsAt] = useState(toDateInput(coupon?.startsAt ?? null));
  const [expiresAt, setExpiresAt] = useState(toDateInput(coupon?.expiresAt ?? null));
  const [isActive, setIsActive] = useState(coupon?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  const toCents = (s: string) => Math.round((parseFloat(s.replace(",", ".")) || 0) * 100);
  const toIntOrNull = (s: string) => (s.trim() === "" ? null : Math.trunc(Number(s)));

  const codeValid = /^[A-Za-z0-9_-]{3,32}$/.test(code.trim());
  const valueValid =
    type === "percent"
      ? Number(percentOff) >= 1 && Number(percentOff) <= 100
      : toCents(valueReais) > 0;
  const canSave = codeValid && valueValid && !pending;

  const submit = () => {
    setError(null);
    if (!codeValid) {
      setError("Código deve ter 3–32 caracteres (letras, números, - ou _).");
      return;
    }
    if (type === "percent" && !(Number(percentOff) >= 1 && Number(percentOff) <= 100)) {
      setError("Percentual deve estar entre 1 e 100.");
      return;
    }
    if (type === "fixed" && toCents(valueReais) <= 0) {
      setError("Valor fixo deve ser maior que zero.");
      return;
    }
    if (startsAt && expiresAt && new Date(expiresAt) <= new Date(startsAt)) {
      setError("A data de expiração deve ser posterior ao início.");
      return;
    }

    const payload: CouponFormPayload = {
      code: code.trim().toUpperCase(),
      type,
      percentOff: type === "percent" ? Math.trunc(Number(percentOff)) : null,
      valueCents: type === "fixed" ? toCents(valueReais) : null,
      minSubtotalCents: minReais.trim() === "" ? 0 : toCents(minReais),
      maxRedemptions: toIntOrNull(maxRedemptions),
      perUserLimit: toIntOrNull(perUserLimit),
      isActive,
      startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
    onSave(isNew ? null : coupon.id, payload);
  };

  return (
    <Modal
      title={isNew ? "Novo cupom" : "Editar cupom"}
      sub={isNew ? undefined : coupon.code}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className={styles.primary} onClick={submit} disabled={!canSave}>
            {pending ? "Salvando…" : "Salvar"}
          </button>
        </>
      }
    >
      <div className={styles.grid}>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label} htmlFor="cp-code">
            Código
          </label>
          <input
            id="cp-code"
            className={styles.input}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Ex.: BEMVINDO10"
            autoCapitalize="characters"
            required
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="cp-type">
            Tipo
          </label>
          <select
            id="cp-type"
            className={styles.select}
            value={type}
            onChange={(e) => setType(e.target.value as CouponType)}
          >
            <option value="percent">Percentual (%)</option>
            <option value="fixed">Valor fixo (R$)</option>
          </select>
        </div>

        {type === "percent" ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cp-pct">
              Percentual (%)
            </label>
            <input
              id="cp-pct"
              className={styles.input}
              type="number"
              min={1}
              max={100}
              step={1}
              value={percentOff}
              onChange={(e) => setPercentOff(e.target.value)}
              required
            />
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cp-val">
              Valor (R$)
            </label>
            <input
              id="cp-val"
              className={styles.input}
              type="text"
              inputMode="decimal"
              value={valueReais}
              onChange={(e) => setValueReais(e.target.value)}
              placeholder="0,00"
              required
            />
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="cp-min">
            Mín. do pedido (R$)
          </label>
          <input
            id="cp-min"
            className={styles.input}
            type="text"
            inputMode="decimal"
            value={minReais}
            onChange={(e) => setMinReais(e.target.value)}
            placeholder="0,00 (sem mínimo)"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="cp-max">
            Limite total de usos
          </label>
          <input
            id="cp-max"
            className={styles.input}
            type="number"
            min={0}
            step={1}
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            placeholder="Vazio = ilimitado"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="cp-peruser">
            Limite por usuário
          </label>
          <input
            id="cp-peruser"
            className={styles.input}
            type="number"
            min={1}
            step={1}
            value={perUserLimit}
            onChange={(e) => setPerUserLimit(e.target.value)}
            placeholder="Vazio = sem limite"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="cp-start">
            Início
          </label>
          <input
            id="cp-start"
            className={styles.input}
            type="date"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="cp-end">
            Expiração
          </label>
          <input
            id="cp-end"
            className={styles.input}
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>

        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>Cupom ativo</span>
          </label>
        </div>

        {error && (
          <p className={`${styles.error} ${styles.full}`} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

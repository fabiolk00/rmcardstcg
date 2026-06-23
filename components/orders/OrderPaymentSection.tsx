"use client";

import { useState } from "react";
import { getOrderPix, type OrderPix } from "@/app/(storefront)/minhas-compras/actions";
import styles from "./OrderPaymentSection.module.css";

// Mensagens para os motivos ESPERADOS de PIX indisponivel (não são erros de fluxo).
const REASON_MSG: Record<string, string> = {
  not_pending: "Este pedido não está mais pendente de pagamento.",
  asaas_off: "Pagamento PIX indisponível no momento. Fale com o suporte para concluir.",
  no_charge: "Ainda não há cobrança PIX vinculada a este pedido. Tente novamente em instantes.",
  qr_unavailable: "QR Code temporariamente indisponível. Tente novamente.",
};

/**
 * Recuperacao do PIX de um pedido pendente (Minhas Compras > detalhe). Busca o QR
 * sob demanda via server action (que valida posse e re-deriva o MESMO QR da cobranca
 * existente). Espelha o painel de sucesso do checkout: imagem base64 + copia-e-cola.
 */
export function OrderPaymentSection({ orderId }: { orderId: string }) {
  const [loading, setLoading] = useState(false);
  const [pix, setPix] = useState<OrderPix | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    setMsg(null);
    const res = await getOrderPix(orderId);
    setLoading(false);
    if (res.ok) {
      setPix(res.pix);
    } else {
      setPix(null);
      setMsg(
        res.reason === "error"
          ? res.error
          : (REASON_MSG[res.reason] ?? "Não foi possível carregar o PIX."),
      );
    }
  }

  async function copy() {
    if (!pix) return;
    try {
      await navigator.clipboard.writeText(pix.payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard indisponivel — o cliente ainda copia manualmente do campo.
    }
  }

  return (
    <div className={styles.box}>
      {!pix && (
        <button type="button" className={styles.payBtn} onClick={load} disabled={loading}>
          {loading ? "Carregando…" : "Mostrar PIX para pagar"}
        </button>
      )}

      {msg && (
        <p className={styles.msg} role="alert">
          {msg}
        </p>
      )}

      {pix && (
        <div className={styles.pixBox}>
          {/* QR vem como base64 do Asaas; data URI não se beneficia do next/image. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.qr}
            src={`data:image/png;base64,${pix.encodedImage}`}
            alt="QR Code do PIX"
            width={200}
            height={200}
          />
          <label className={styles.label} htmlFor={`pix-${orderId}`}>
            PIX copia-e-cola
          </label>
          <div className={styles.copyRow}>
            <input id={`pix-${orderId}`} className={styles.input} readOnly value={pix.payload} />
            <button type="button" className={styles.copyBtn} onClick={copy}>
              {copied ? "Copiado!" : "Copiar"}
            </button>
          </div>
          <button type="button" className={styles.refresh} onClick={load} disabled={loading}>
            {loading ? "Atualizando…" : "Atualizar QR"}
          </button>
        </div>
      )}
    </div>
  );
}

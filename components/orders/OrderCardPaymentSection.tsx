"use client";

import { useState } from "react";
import { getOrderInvoiceUrl } from "@/app/(storefront)/minhas-compras/actions";
import styles from "./OrderPaymentSection.module.css";

// Mensagens para os motivos ESPERADOS de fatura indisponivel (não são erros de fluxo).
const REASON_MSG: Record<string, string> = {
  not_pending: "Este pedido não está mais pendente de pagamento.",
  asaas_off: "Pagamento por cartão indisponível no momento. Fale com o suporte para concluir.",
  no_charge: "Ainda não há cobrança vinculada a este pedido. Tente novamente em instantes.",
  unavailable: "Fatura temporariamente indisponível. Tente novamente.",
};

/**
 * Recuperacao da FATURA (cartao) de um pedido pendente (Minhas Compras > detalhe).
 * Analogo ao OrderPaymentSection do PIX, mas abre a fatura hospedada do Asaas
 * (invoiceUrl) — a loja nunca toca no dado do cartao. Busca sob demanda via server
 * action (que valida posse e re-deriva a fatura da cobranca ja existente).
 */
export function OrderCardPaymentSection({ orderId }: { orderId: string }) {
  const [loading, setLoading] = useState(false);
  const [invoiceUrl, setInvoiceUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setMsg(null);
    const res = await getOrderInvoiceUrl(orderId);
    setLoading(false);
    if (res.ok) {
      setInvoiceUrl(res.invoiceUrl);
    } else {
      setInvoiceUrl(null);
      setMsg(
        res.reason === "error"
          ? res.error
          : (REASON_MSG[res.reason] ?? "Não foi possível carregar a fatura."),
      );
    }
  }

  return (
    <div className={styles.box}>
      {!invoiceUrl && (
        <button type="button" className={styles.payBtn} onClick={load} disabled={loading}>
          {loading ? "Carregando…" : "Abrir fatura para pagar"}
        </button>
      )}

      {msg && (
        <p className={styles.msg} role="alert">
          {msg}
        </p>
      )}

      {invoiceUrl && (
        <a className={styles.invoiceLink} href={invoiceUrl} target="_blank" rel="noopener noreferrer">
          Pagar no cartão pela fatura do Asaas
        </a>
      )}
    </div>
  );
}

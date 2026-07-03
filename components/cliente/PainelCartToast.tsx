"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useCart } from "@/lib/cart/CartContext";
import { Icon } from "@/components/ui/Icon";
import styles from "./PainelCartToast.module.css";

// Tempo de exibicao do aviso (o suficiente para ler; some sozinho).
const TOAST_MS = 2600;

/**
 * Aviso "adicionado ao carrinho" do PAINEL do cliente: reage ao lastAdded do
 * CartContext (todo add — Compre agora dos cards, etc.) e mostra um toast
 * acessivel (role=status) no canto superior direito, com atalho para o
 * carrinho. Montado no LAYOUT do painel, entao vale para todas as telas.
 */
export function PainelCartToast() {
  const { lastAdded } = useCart();
  // Visibilidade DERIVADA (sem setState sincrono em effect): mostra enquanto o
  // add mais recente ainda nao foi "dispensado" pelo timer.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const visible = lastAdded !== null && lastAdded.at !== dismissedAt;

  useEffect(() => {
    if (!lastAdded) return;
    const timer = setTimeout(() => setDismissedAt(lastAdded.at), TOAST_MS);
    return () => clearTimeout(timer);
  }, [lastAdded]);

  if (!visible) return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      <span className={styles.check}>
        <Icon name="check" size={16} />
      </span>
      <span className={styles.text}>
        <strong className={styles.name}>{lastAdded.name}</strong> adicionado ao carrinho
      </span>
      <Link href="/painel/carrinho" className={styles.link}>
        Ver carrinho
      </Link>
    </div>
  );
}

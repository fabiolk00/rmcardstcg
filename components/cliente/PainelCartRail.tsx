"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCart } from "@/lib/cart/CartContext";
import { cartTotals } from "@/lib/cart/totals";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import { Icon } from "@/components/ui/Icon";
import styles from "./PainelCartRail.module.css";

// Telas onde o rail NAO aparece: carrinho (redundante — e a propria tela),
// conta (formulario; sem contexto de compra) e checkout (o proprio Resumo do
// CheckoutView ja faz esse papel — o rail duplicaria a informacao).
const HIDDEN_PREFIXES = ["/painel/carrinho", "/painel/conta", "/painel/checkout"];

/**
 * Rail lateral DIREITO com o resumo do carrinho, presente em todas as telas do
 * painel do cliente exceto Carrinho, Conta e Checkout. Le o MESMO CartContext
 * das telas (adds das Colecoes refletem na hora) e leva ao checkout do painel.
 */
export function PainelCartRail() {
  const pathname = usePathname();
  const { lines, hydrated, count } = useCart();

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  const totals = cartTotals(lines);

  return (
    <aside className={styles.rail} aria-label="Resumo do carrinho">
      <div className={styles.head}>
        <span className={styles.headIcon}>
          <Icon name="cart" size={16} />
        </span>
        <span className={styles.headTitle}>Carrinho</span>
        {hydrated && count > 0 && <span className={styles.badge}>{count}</span>}
      </div>

      {!hydrated ? (
        <p className={styles.empty}>Carregando…</p>
      ) : lines.length === 0 ? (
        <div className={styles.emptyWrap}>
          <p className={styles.empty}>Seu carrinho está vazio.</p>
          <Link href="/painel/colecoes" className={styles.browse}>
            Ver coleções
          </Link>
        </div>
      ) : (
        <>
          <ul className={styles.items}>
            {lines.map((l) => (
              <li key={l.product.id} className={styles.item}>
                <span className={styles.itemName}>{l.product.name}</span>
                <span className={styles.itemMeta}>
                  <span className={styles.itemQty}>{l.quantity}×</span>
                  <span className="tnum">{formatBRL(finalPriceCents(l.product) * l.quantity)}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className={styles.subtotal}>
            <span>Subtotal</span>
            <span className="tnum">{formatBRL(totals.merchandiseCents)}</span>
          </div>
          <p className={styles.hint}>Frete calculado no checkout.</p>

          <Link href="/painel/checkout" className={styles.checkout}>
            Finalizar compra
          </Link>
          <Link href="/painel/carrinho" className={styles.viewCart}>
            Ver carrinho
          </Link>
        </>
      )}
    </aside>
  );
}

"use client";

import Image from "next/image";
import Link from "next/link";
import { useCart } from "@/lib/cart/CartContext";
import { cartTotals } from "@/lib/cart/totals";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import { Icon } from "@/components/ui/Icon";
import styles from "./CartView.module.css";

export function CartView() {
  const { lines, hydrated, setQuantity, remove } = useCart();

  if (!hydrated) {
    return <p className={styles.loading}>Carregando…</p>;
  }

  if (lines.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>Seu carrinho está vazio.</div>
        <p className={styles.emptySub}>Explore o catálogo e adicione seus produtos.</p>
        <Link href="/colecoes" className={styles.primary}>
          Ver coleção
        </Link>
      </div>
    );
  }

  const totals = cartTotals(lines);
  const freeShipping = totals.shippingCents === 0;

  return (
    <div className={styles.layout}>
      <ul className={styles.items}>
        {lines.map((line) => {
          const unit = finalPriceCents(line.product);
          return (
            <li key={line.product.id} className={styles.item}>
              <Link href={`/produto/${line.product.slug}`} className={styles.thumb}>
                <Image
                  src={line.product.imageUrl}
                  alt={line.product.name}
                  fill
                  sizes="64px"
                  className={styles.thumbImg}
                />
              </Link>

              <div className={styles.info}>
                <Link href={`/produto/${line.product.slug}`} className={styles.name}>
                  {line.product.name}
                </Link>
                <span className={`${styles.unit} tnum`}>{formatBRL(unit)} cada</span>
              </div>

              <div className={styles.stepper}>
                <button
                  type="button"
                  onClick={() => setQuantity(line.product.id, line.quantity - 1)}
                  disabled={line.quantity <= 1}
                  aria-label={`Diminuir quantidade de ${line.product.name}`}
                >
                  <Icon name="minus" size={14} />
                </button>
                <span className={styles.qty}>{line.quantity}</span>
                <button
                  type="button"
                  onClick={() => setQuantity(line.product.id, line.quantity + 1)}
                  disabled={line.quantity >= line.product.stock}
                  aria-label={`Aumentar quantidade de ${line.product.name}`}
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>

              <span className={`${styles.lineTotal} tnum`}>{formatBRL(unit * line.quantity)}</span>

              <button
                type="button"
                className={styles.remove}
                onClick={() => remove(line.product.id)}
                aria-label={`Remover ${line.product.name}`}
              >
                <Icon name="trash" size={16} />
              </button>
            </li>
          );
        })}
      </ul>

      <aside className={styles.summary}>
        <h2 className={styles.summaryTitle}>Resumo</h2>
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt>Subtotal</dt>
            <dd className="tnum">{formatBRL(totals.subtotalCents)}</dd>
          </div>
          {totals.discountCents > 0 && (
            <div className={styles.row}>
              <dt>Desconto</dt>
              <dd className="tnum">- {formatBRL(totals.discountCents)}</dd>
            </div>
          )}
          <div className={styles.row}>
            <dt>Frete</dt>
            <dd className="tnum">{freeShipping ? "Grátis" : formatBRL(totals.shippingCents)}</dd>
          </div>
        </dl>

        {!freeShipping && (
          <p className={styles.freightHint}>
            Faltam {formatBRL(totals.remainingForFreeCents)} para frete grátis.
          </p>
        )}

        <div className={styles.total}>
          <span>Total</span>
          <span className="tnum">{formatBRL(totals.totalCents)}</span>
        </div>

        <button type="button" className={styles.checkout} disabled>
          Finalizar compra
        </button>
        <p className={styles.checkoutHint}>Pagamento via PIX entra em breve.</p>
        <Link href="/colecoes" className={styles.continue}>
          Continuar comprando
        </Link>
      </aside>
    </div>
  );
}

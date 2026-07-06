"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useCart } from "@/lib/cart/CartContext";
import { finalPriceCents } from "@/lib/data/pricing";
import type { Product } from "@/lib/data/types";
import { Icon } from "@/components/ui/Icon";
import { formatBRL } from "@/lib/utils/currency";
import { Stars } from "./Stars";
import styles from "./ProductInfo.module.css";

// Abaixo deste estoque mostramos urgencia ("Ultimas N unidades").
const LOW_STOCK_THRESHOLD = 5;

export function ProductInfo({ product }: { product: Product }) {
  const { add } = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const soldOut = product.available <= 0;
  const hasDiscount = product.discountPct > 0;
  const final = finalPriceCents(product);
  // Trava de UI: 1..disponivel (a camada de servico — CartContext — tambem reclampa).
  const clampQty = (n: number) => Math.max(1, Math.min(n, product.available));

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function handleAdd() {
    if (soldOut) return;
    add(product, clampQty(qty));
    setAdded(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(false), 4000);
  }

  return (
    <div className={styles.info}>
      <div className={styles.cat}>{product.category}</div>
      <h1 className={styles.name}>{product.name}</h1>

      <div className={styles.rating}>
        <Stars rating={product.rating} size={16} />
        <span className={styles.ratingValue}>{product.rating.toFixed(1)}</span>
        <span className={styles.ratingCount}>
          {product.reviewCount} {product.reviewCount === 1 ? "avaliação" : "avaliações"}
        </span>
      </div>

      <div className={styles.priceRow}>
        {hasDiscount && (
          <span className={`${styles.strike} tnum`}>{formatBRL(product.priceCents)}</span>
        )}
        <span className={`${styles.price} tnum`}>{formatBRL(final)}</span>
        {hasDiscount && <span className={styles.discount}>-{product.discountPct}%</span>}
      </div>

      <p className={styles.stock} aria-live="polite">
        {soldOut ? (
          <span className={styles.stockOut}>Esgotado</span>
        ) : product.available <= LOW_STOCK_THRESHOLD ? (
          <span className={styles.stockLow}>
            Últimas {product.available} {product.available === 1 ? "unidade" : "unidades"}
          </span>
        ) : (
          <span className={styles.stockIn}>Em estoque</span>
        )}
      </p>

      {!soldOut && (
        <div className={styles.qtyRow}>
          <span className={styles.qtyLabel}>Quantidade</span>
          <div className={styles.stepper}>
            <button
              type="button"
              className={styles.stepBtn}
              onClick={() => setQty((n) => clampQty(n - 1))}
              disabled={qty <= 1}
              aria-label="Diminuir quantidade"
            >
              <Icon name="minus" size={16} />
            </button>
            <span className={styles.qtyValue} aria-live="polite">
              {qty}
            </span>
            <button
              type="button"
              className={styles.stepBtn}
              onClick={() => setQty((n) => clampQty(n + 1))}
              disabled={qty >= product.available}
              aria-label="Aumentar quantidade"
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.addBtn}
          onClick={handleAdd}
          disabled={soldOut}
          aria-label={`Adicionar ${product.name} ao carrinho`}
        >
          <Icon name="cart" size={18} />
          <span>{soldOut ? "Indisponível" : "Adicionar ao carrinho"}</span>
        </button>

        {added && (
          <div className={styles.addedNote} role="status">
            <span>Adicionado ao carrinho ✓</span>
            <Link href="/carrinho" className={styles.cartLink}>
              Ver carrinho <Icon name="arrow" size={14} />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

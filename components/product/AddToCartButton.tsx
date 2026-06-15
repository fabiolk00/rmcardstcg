"use client";

import { useCart } from "@/lib/cart/CartContext";
import type { CartProduct } from "@/lib/cart/totals";
import { Icon } from "@/components/ui/Icon";
import styles from "./ProductCard.module.css";

export function AddToCartButton({ product }: { product: CartProduct }) {
  const { add } = useCart();
  return (
    <button
      type="button"
      className={styles.add}
      onClick={() => add(product)}
      aria-label={`Adicionar ${product.name} ao carrinho`}
    >
      <span>Compre agora</span>
      <Icon name="plus" size={22} />
    </button>
  );
}

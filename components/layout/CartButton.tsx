"use client";

import Link from "next/link";
import { useCart } from "@/lib/cart/CartContext";
import { Icon } from "@/components/ui/Icon";
import styles from "./Topbar.module.css";

export function CartButton() {
  const { count, hydrated } = useCart();
  const show = hydrated && count > 0;
  return (
    <Link
      href="/carrinho"
      className={styles.cart}
      aria-label={show ? `Carrinho, ${count} ${count === 1 ? "item" : "itens"}` : "Carrinho"}
    >
      <Icon name="cart" size={20} />
      {show && <span className={styles.cartCount}>{count}</span>}
    </Link>
  );
}

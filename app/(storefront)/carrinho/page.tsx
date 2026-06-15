import { CartView } from "@/components/cart/CartView";
import styles from "./carrinho.module.css";

export default function CarrinhoPage() {
  return (
    <section>
      <h1 className={styles.title}>Carrinho</h1>
      <CartView />
    </section>
  );
}

import { CartView } from "@/components/cart/CartView";
import styles from "./carrinho.module.css";

// Carrinho do painel do cliente: reusa o CartView da vitrine (mesmo carrinho,
// mesmo CartProvider — o do layout do painel); so o CTA aponta para o
// checkout do painel. Estados de carregando/vazio ja vem do CartView.
export default function PainelCarrinhoPage() {
  return (
    <section>
      <h1 className={styles.title}>Carrinho</h1>
      <CartView checkoutHref="/painel/checkout" />
    </section>
  );
}

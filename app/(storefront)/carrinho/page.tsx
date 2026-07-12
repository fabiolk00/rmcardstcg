import { redirectLoggedInFromStorefront } from "@/lib/auth/resolveViewer";
import { CartView } from "@/components/cart/CartView";
import styles from "./carrinho.module.css";

// Dinamica: decide por sessao (cliente logado -> carrinho do painel; o estado
// do carrinho e o MESMO — CartProvider compartilha o localStorage).
export const dynamic = "force-dynamic";

export default async function CarrinhoPage() {
  await redirectLoggedInFromStorefront("/painel/carrinho");
  return (
    <section>
      <h1 className={styles.title}>Carrinho</h1>
      <CartView />
    </section>
  );
}

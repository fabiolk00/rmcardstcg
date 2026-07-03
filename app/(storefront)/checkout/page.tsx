import { redirectClienteToPainel } from "@/lib/auth/resolveViewer";
import { CheckoutView } from "@/components/checkout/CheckoutView";
import styles from "./checkout.module.css";

// Dinamica: cliente logado finaliza no checkout do painel (com prefill do
// perfil da Conta); anonimo segue na vitrine (o middleware ja exige login
// nesta rota quando o Clerk esta ativo).
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  await redirectClienteToPainel("/painel/checkout");
  return (
    <section>
      <h1 className={styles.title}>Finalizar compra</h1>
      <CheckoutView />
    </section>
  );
}

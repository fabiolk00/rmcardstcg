import { redirectLoggedInFromStorefront } from "@/lib/auth/resolveViewer";
import { CheckoutView } from "@/components/checkout/CheckoutView";
import styles from "./checkout.module.css";

// Dinamica: cliente logado finaliza no checkout do painel (com prefill do
// perfil da Conta); anonimo segue na vitrine (o middleware ja exige login
// nesta rota quando o Clerk esta ativo).
export const dynamic = "force-dynamic";

// Orcamento de execucao da rota (a server action de checkout roda aqui): cobranca
// no Asaas + cotacao de frete + transacao de pedido. Sem isso vale o default da
// plataforma, que a cotacao lenta conseguia estourar — derrubando a compra inteira.
export const maxDuration = 60;

export default async function CheckoutPage() {
  await redirectLoggedInFromStorefront("/painel/checkout");
  return (
    <section>
      <h1 className={styles.title}>Finalizar compra</h1>
      <CheckoutView />
    </section>
  );
}

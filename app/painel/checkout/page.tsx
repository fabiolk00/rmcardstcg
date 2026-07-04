import { redirect } from "next/navigation";

import { CheckoutView } from "@/components/checkout/CheckoutView";
import { requireActiveUser } from "@/lib/auth/requireActiveUser";
import { toInitialCustomer, type CustomerProfileLike } from "./prefill";
import styles from "./checkout.module.css";

// Checkout do painel do cliente: mesmo CheckoutView da vitrine (checkout
// action, cupom, frete SuperFrete e PIX intocados), com prefill do perfil
// salvo em /painel/conta. Sempre ao vivo — o perfil pode mudar entre acessos.
export const dynamic = "force-dynamic";

// Ponte de integracao com o modulo do agente B (lib/data/profile nasce em
// paralelo): import dinamico + checagem da funcao. Se getCustomerProfile
// ainda nao existir (ou falhar), o prefill degrada para form vazio — o
// checkout continua funcional. Trocar por import estatico quando B publicar.
async function loadCustomerProfile(clerkUserId: string): Promise<CustomerProfileLike | null> {
  try {
    const mod = (await import("@/lib/data/profile")) as {
      getCustomerProfile?: (clerkUserId: string) => Promise<CustomerProfileLike | null>;
    };
    if (typeof mod.getCustomerProfile !== "function") return null;
    return await mod.getCustomerProfile(clerkUserId);
  } catch (err) {
    console.error(
      "[painel/checkout] prefill do perfil indisponivel:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export default async function PainelCheckoutPage() {
  // Guard do cliente (contrato): sem sessao -> /entrar; soft-deleted -> /.
  const active = await requireActiveUser();
  if (!active.ok) redirect(active.reason === "deleted" ? "/" : "/entrar");

  const profile = await loadCustomerProfile(active.userId);
  const initialCustomer = profile ? toInitialCustomer(profile) : undefined;

  return (
    <section>
      <h1 className={styles.title}>Finalizar compra</h1>
      <CheckoutView initialCustomer={initialCustomer} />
    </section>
  );
}

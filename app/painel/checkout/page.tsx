import { redirect } from "next/navigation";

import { CheckoutView, type Form } from "@/components/checkout/CheckoutView";
import { requireActiveUser } from "@/lib/auth/requireActiveUser";
import styles from "./checkout.module.css";

// Checkout do painel do cliente: mesmo CheckoutView da vitrine (checkout
// action, cupom, frete SuperFrete e PIX intocados), com prefill do perfil
// salvo em /painel/conta. Sempre ao vivo — o perfil pode mudar entre acessos.
export const dynamic = "force-dynamic";

// Forma minima do perfil que o prefill consome (contrato do CONTRACT.md —
// modelo CustomerProfile do agente B). Superset do Form do checkout.
type CustomerProfileLike = {
  name: string;
  email: string | null;
  phone: string;
  cpfCnpj: string | null;
  cep: string;
  street: string;
  number: string | null;
  complement: string | null;
  city: string;
  state: string;
};

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

// CEP salvo sem mascara (8 digitos) -> exibicao NNNNN-NNN, como a UI do checkout.
function formatCep(cep: string): string {
  const digits = cep.replace(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : cep;
}

// Mapa perfil -> Form do checkout (CONTRACT.md): street = street + ", " +
// number (+ complement) quando number existir; demais campos 1:1.
function toInitialCustomer(profile: CustomerProfileLike): Partial<Form> {
  const street = profile.number
    ? `${profile.street}, ${profile.number}${profile.complement ? ` ${profile.complement}` : ""}`
    : profile.street;
  return {
    name: profile.name,
    email: profile.email ?? "",
    phone: profile.phone,
    cpfCnpj: profile.cpfCnpj ?? "",
    cep: formatCep(profile.cep),
    street,
    city: profile.city,
    state: profile.state,
  };
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

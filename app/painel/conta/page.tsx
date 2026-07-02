import { redirect } from "next/navigation";

import { requireActiveUser } from "@/lib/auth/requireActiveUser";
import { getCustomerProfile } from "@/lib/data/profile";
import { ContaForm } from "./ContaForm";
import styles from "./conta.module.css";

// Perfil do usuario — sempre ao vivo (nada de snapshot no build).
export const dynamic = "force-dynamic";

/**
 * Tela Conta do painel do cliente: carrega o perfil no SERVER e entrega os
 * defaults ao form (client). Guard proprio alem do layout (defense-in-depth,
 * padrao de minhas-compras): unauthenticated -> /entrar; deleted -> /.
 * getCustomerProfile e tolerante (erro/tabela ausente -> null): a tela degrada
 * para o form vazio em vez de quebrar.
 */
export default async function ContaPage() {
  const active = await requireActiveUser();
  if (!active.ok) redirect(active.reason === "deleted" ? "/" : "/entrar");

  const profile = await getCustomerProfile(active.userId);

  return (
    <section>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Conta</h1>
          <p className={styles.sub}>
            Seu perfil e endereço de entrega. Esses dados preenchem o checkout automaticamente.
          </p>
        </div>
      </div>

      <ContaForm initialProfile={profile} />
    </section>
  );
}

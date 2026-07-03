import { currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminProfileCard } from "@/components/admin/AdminProfileCard";
import { ClienteNav } from "@/components/cliente/ClienteNav";
import { ClienteProfileMenu } from "@/components/cliente/ClienteProfileMenu";
import { requireActiveUser } from "@/lib/auth/requireActiveUser";
import { CartProvider } from "@/lib/cart/CartContext";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import styles from "./painel.module.css";

// Shell do painel do CLIENTE — irmao do admin (app/admin/layout.tsx), mesmas
// classes/tokens. Acesso: requireActiveUser (login + espelho ativo); mock-first
// (sem Clerk) segue como guest, padrao do repo. O CartProvider envolve TUDO:
// as telas do painel (colecoes/carrinho/checkout) dependem do carrinho.
export default async function PainelLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const active = await requireActiveUser();
  if (!active.ok) redirect(active.reason === "deleted" ? "/" : "/entrar");

  const clerkEnabled = isClerkConfigured();
  // Email exibido no card de perfil; placeholder no modo demo (dev sem Clerk).
  let email = "cliente@rmcards.com.br";

  if (clerkEnabled) {
    const user = await currentUser();
    if (!user) redirect("/entrar");
    email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? email;
  }

  return (
    <CartProvider>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <Link href="/painel/pedidos" className={styles.brand}>
            <span className={styles.brandMark}>
              <span className={styles.brandMarkRM}>RM</span>
              <span className={styles.brandMarkSub}>CARDS</span>
            </span>
            <span className={styles.brandText}>
              <span className={styles.brandName}>RM Cards</span>
              <span className={styles.brandSub}>Minha conta</span>
            </span>
          </Link>

          <ClienteNav />

          {clerkEnabled ? (
            <ClienteProfileMenu email={email} roleLabel="Cliente" />
          ) : (
            <AdminProfileCard
              email={email}
              roleLabel="Cliente"
              colecoesHref="/painel/colecoes"
              contaHref="/painel/conta"
            />
          )}
        </aside>

        <div className={styles.main}>
          <header className={styles.topbar}>
            <span className={styles.topbarTitle}>Painel do cliente</span>
          </header>
          <main className={styles.content}>{children}</main>
        </div>
      </div>
    </CartProvider>
  );
}

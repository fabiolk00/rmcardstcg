import { currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin/AdminNav";
import { AdminProfileCard } from "@/components/admin/AdminProfileCard";
import { AdminProfileMenu } from "@/components/admin/AdminProfileMenu";
import { effectiveRole } from "@/lib/auth/effectiveRole";
import { getUserRole } from "@/lib/data/users";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import styles from "./admin.module.css";

// Acesso a /admin: login (middleware) + ROLE admin (F9). A role vem da tabela
// users (sincronizada pelo webhook Clerk); fallback por ADMIN_EMAILS cobre o
// usuario ainda nao sincronizado. Mock-first (sem Clerk): liberado para dev.
export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const clerkEnabled = isClerkConfigured();
  // Email exibido no card de perfil; placeholder no modo demo (dev sem Clerk).
  let email = "admin@rmcards.com.br";

  if (clerkEnabled) {
    const user = await currentUser();
    if (!user) redirect("/entrar");
    const resolvedEmail =
      user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
    email = resolvedEmail ?? email;
    const decision = effectiveRole(await getUserRole(user.id), resolvedEmail);

    // "unverified": sessao viva, mas nao deu pra confirmar a role (espelho sem sync
    // E currentUser sem e-mail — tipico de re-handshake pos-idle). NAO rebaixa: manda
    // re-autenticar, que restabelece o estado em vez de exibir "voce virou cliente".
    if (decision.role === "unverified") {
      console.warn("[auth] /admin: role nao confirmada (unverified) — re-autenticando", {
        clerkUserId: user.id,
      });
      redirect("/entrar");
    }
    if (decision.role !== "admin") redirect("/");
    // Admin sustentado SO pelo fallback ADMIN_EMAILS (espelho sem role admin): estado
    // fragil que precede o rebaixamento. Logar para diagnosticar em producao.
    if (decision.source === "allowlist") {
      console.warn("[auth] /admin: acesso admin apenas via ADMIN_EMAILS (espelho sem role admin)", {
        clerkUserId: user.id,
        email,
      });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Fail-closed: sem Clerk configurado, /admin nunca fica aberto em producao
    // (mock-first aberto vale so para dev). Configure as chaves Clerk no deploy.
    redirect("/");
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/admin/produtos" className={styles.brand}>
          <span className={styles.brandMark}>
            <span className={styles.brandMarkRM}>RM</span>
            <span className={styles.brandMarkSub}>CARDS</span>
          </span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>RM Cards</span>
            <span className={styles.brandSub}>Admin</span>
          </span>
        </Link>

        <AdminNav />

        {clerkEnabled ? (
          <AdminProfileMenu email={email} roleLabel="Administrador" />
        ) : (
          <AdminProfileCard email={email} roleLabel="Administrador" />
        )}
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <span className={styles.topbarTitle}>Painel administrativo</span>
        </header>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}

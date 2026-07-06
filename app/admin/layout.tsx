import { currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin/AdminNav";
import { AdminProfileCard } from "@/components/admin/AdminProfileCard";
import { AdminProfileMenu } from "@/components/admin/AdminProfileMenu";
import { getUserRole } from "@/lib/data/users";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { isAdminEmail } from "@/lib/services/clerk/roles";
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
    email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? email;
    const role = (await getUserRole(user.id)) ?? (isAdminEmail(email) ? "admin" : "cliente");
    if (role !== "admin") redirect("/");
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

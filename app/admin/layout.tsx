import { currentUser } from "@clerk/nextjs/server";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin/AdminNav";
import { AdminUserArea } from "@/components/admin/AdminUserArea";
import { Icon } from "@/components/ui/Icon";
import { getUserRole } from "@/lib/data/users";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { isAdminEmail } from "@/lib/services/clerk/roles";
import styles from "./admin.module.css";

// Acesso a /admin: login (middleware) + ROLE admin (F9). A role vem da tabela
// users (sincronizada pelo webhook Clerk); fallback por ADMIN_EMAILS cobre o
// usuario ainda nao sincronizado. Mock-first (sem Clerk): liberado para dev.
export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const clerkEnabled = isClerkConfigured();

  if (clerkEnabled) {
    const user = await currentUser();
    if (!user) redirect("/entrar");
    const email =
      user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
    const role = (await getUserRole(user.id)) ?? (isAdminEmail(email) ? "admin" : "cliente");
    if (role !== "admin") redirect("/");
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/admin/produtos" className={styles.brand}>
          <span className={styles.brandMark}>
            <Image
              src="/logo-rm.png"
              alt="RM Cards"
              width={28}
              height={28}
              className={styles.brandLogo}
            />
          </span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>RM Cards</span>
            <span className={styles.brandSub}>Admin</span>
          </span>
        </Link>

        <AdminNav />

        <div className={styles.foot}>
          <Link href="/" className={styles.viewStore}>
            <Icon name="arrow" size={14} />
            <span>Ver loja</span>
          </Link>
          {clerkEnabled ? <AdminUserArea /> : <span className={styles.demoBadge}>Modo demo</span>}
        </div>
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

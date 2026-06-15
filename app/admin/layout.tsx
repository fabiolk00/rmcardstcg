import Image from "next/image";
import Link from "next/link";
import { AdminNav } from "@/components/admin/AdminNav";
import { AdminUserArea } from "@/components/admin/AdminUserArea";
import { Icon } from "@/components/ui/Icon";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import styles from "./admin.module.css";

// O acesso a /admin exige login (middleware do F5 quando Clerk ativo).
// O guard por ROLE (cliente/admin) entra no F9 (tabela users + role no server).
export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const clerkEnabled = isClerkConfigured();

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

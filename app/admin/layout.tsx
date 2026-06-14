import Link from "next/link";
import styles from "./admin.module.css";

// Guard por role (cliente/admin) entra no slice F9, quando houver Clerk + tabela users.
export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>RM Cards</div>
        <nav className={styles.nav}>
          <Link href="/admin/produtos">Produtos</Link>
          <Link href="/admin/pedidos">Pedidos</Link>
        </nav>
      </aside>
      <div className={styles.main}>
        <header className={styles.topbar}>
          <span className={styles.crumb}>Admin</span>
        </header>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}

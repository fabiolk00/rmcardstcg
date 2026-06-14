import Link from "next/link";
import styles from "./storefront.module.css";

export default function StorefrontLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={`container ${styles.topbarInner}`}>
          <Link href="/" className={styles.brand}>
            RM Cards
          </Link>
          <nav className={styles.nav}>
            <Link href="/">Início</Link>
            <Link href="/colecoes">Coleções</Link>
          </nav>
        </div>
      </header>

      <main className="container page">{children}</main>

      <footer className={styles.footer}>
        <div className="container">
          <small>© RM Cards — Pokémon TCG</small>
        </div>
      </footer>
    </div>
  );
}

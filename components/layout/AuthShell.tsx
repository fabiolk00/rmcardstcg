import Image from "next/image";
import Link from "next/link";
import styles from "./AuthShell.module.css";

// Moldura centralizada para as paginas de Entrar / Criar conta (fora do storefront).
export function AuthShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className={styles.shell}>
      <Link href="/" className={styles.brand} aria-label="RM Cards — início">
        <Image src="/logo-rm.png" alt="RM Cards" width={120} height={40} className={styles.logo} />
      </Link>
      <div className={styles.card}>{children}</div>
    </main>
  );
}

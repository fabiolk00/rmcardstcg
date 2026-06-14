import Image from "next/image";
import Link from "next/link";
import { NavLinks } from "./NavLinks";
import styles from "./Topbar.module.css";

export function Topbar() {
  return (
    <header className={styles.topbar}>
      <div className={`container ${styles.inner}`}>
        <Link href="/" className={styles.brand}>
          <Image
            src="/logo-rm.png"
            alt="RM Cards"
            width={120}
            height={40}
            className={styles.logo}
            priority
          />
        </Link>

        <NavLinks />

        <div className={styles.spacer} />

        <div className={styles.auth}>
          <Link href="/entrar" className={styles.btnGhost}>
            Entrar
          </Link>
          <Link href="/criar-conta" className={styles.btnDark}>
            Criar conta
          </Link>
        </div>
      </div>
    </header>
  );
}

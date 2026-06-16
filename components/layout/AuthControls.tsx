"use client";

import Link from "next/link";
import { UserButton, useAuth } from "@clerk/nextjs";
import styles from "./Topbar.module.css";

// Controles de auth da topbar quando o Clerk esta configurado.
// Clerk v7: SignedIn/SignedOut viraram componentes de SERVIDOR; num client
// component usamos o hook useAuth() (espelha o mesmo comportamento: nada ate
// carregar, depois UserButton se logado ou os links se deslogado).
export function AuthControls() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <div className={styles.auth} />;

  return (
    <div className={styles.auth}>
      {isSignedIn ? (
        <UserButton />
      ) : (
        <>
          <Link href="/entrar" className={styles.btnGhost}>
            Entrar
          </Link>
          <Link href="/criar-conta" className={styles.btnDark}>
            Criar conta
          </Link>
        </>
      )}
    </div>
  );
}

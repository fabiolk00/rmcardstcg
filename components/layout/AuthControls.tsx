"use client";

import Link from "next/link";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import styles from "./Topbar.module.css";

// Controles de auth da topbar quando o Clerk esta configurado.
export function AuthControls() {
  return (
    <div className={styles.auth}>
      <SignedOut>
        <Link href="/entrar" className={styles.btnGhost}>
          Entrar
        </Link>
        <Link href="/criar-conta" className={styles.btnDark}>
          Criar conta
        </Link>
      </SignedOut>
      <SignedIn>
        <UserButton />
      </SignedIn>
    </div>
  );
}

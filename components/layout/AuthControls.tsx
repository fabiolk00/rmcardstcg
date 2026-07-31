"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import styles from "./Topbar.module.css";

// Controles de auth da topbar quando o Clerk esta configurado.
// Clerk v7: SignedIn/SignedOut viraram componentes de SERVIDOR; num client
// component usamos o hook useAuth() (espelha o mesmo comportamento: nada ate
// carregar, depois o atalho de volta se logado ou os links de entrar/criar
// conta se deslogado).
export function AuthControls() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return <div className={styles.auth} />;

  return (
    <div className={styles.auth}>
      {isSignedIn ? (
        // A vitrine agora e visitavel por quem esta logado (excecao da home
        // etc.), mas conta/pedidos/sair continuam vivendo no painel — aqui so
        // um atalho de volta. /pos-login resolve a role e manda pro dashboard
        // certo (admin ou cliente), mesmo roteamento usado logo apos o login.
        <Link href="/pos-login" className={styles.btnDark}>
          Voltar ao Painel
        </Link>
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

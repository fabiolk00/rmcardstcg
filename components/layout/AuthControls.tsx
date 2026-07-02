"use client";

import Link from "next/link";
import { UserButton, useAuth } from "@clerk/nextjs";
import { Icon } from "@/components/ui/Icon";
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
        // Atalho persistente para "Meus Pedidos" no menu da conta — sem ele o
        // cliente logado so tem o UserButton padrao e nenhum caminho de nav ate os
        // pedidos (que agora vivem no painel do cliente).
        <UserButton>
          <UserButton.MenuItems>
            <UserButton.Link
              label="Meus Pedidos"
              labelIcon={<Icon name="receipt" size={14} />}
              href="/painel/pedidos"
            />
          </UserButton.MenuItems>
        </UserButton>
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

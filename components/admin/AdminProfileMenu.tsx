"use client";

import { useClerk } from "@clerk/nextjs";
import { AdminProfileCard } from "./AdminProfileCard";

/**
 * Liga o card de perfil às ações reais do Clerk. Renderizado SÓ quando o Clerk está
 * configurado (sob o ClerkProvider) — por isso `useClerk()` aqui é seguro; no modo
 * mock-first o layout renderiza o AdminProfileCard direto, sem este wrapper.
 *
 *  - Configurações -> abre o perfil/conta do usuário (modal do Clerk).
 *  - Sair          -> signOut e volta para a home.
 */
export function AdminProfileMenu({ email, roleLabel }: { email: string; roleLabel: string }) {
  const { openUserProfile, signOut } = useClerk();
  return (
    <AdminProfileCard
      email={email}
      roleLabel={roleLabel}
      onSettings={() => openUserProfile()}
      onSignOut={() => signOut({ redirectUrl: "/" })}
    />
  );
}

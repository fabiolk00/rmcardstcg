"use client";

import { useClerk } from "@clerk/nextjs";
import { AdminProfileCard } from "@/components/admin/AdminProfileCard";

/**
 * Liga o card de perfil do CLIENTE as acoes reais do Clerk. Renderizado SO quando
 * o Clerk esta configurado (sob o ClerkProvider) — por isso `useClerk()` aqui e
 * seguro; no modo mock-first o layout renderiza o AdminProfileCard direto, sem
 * este wrapper (mesmo padrao do AdminProfileMenu).
 *
 *  - Configurações -> abre o perfil/conta do usuário (modal do Clerk).
 *  - Coleções      -> /painel/colecoes (vitrine dentro do painel).
 *  - Sair          -> signOut e volta para a home.
 */
export function ClienteProfileMenu({ email, roleLabel }: { email: string; roleLabel: string }) {
  const { openUserProfile, signOut } = useClerk();
  return (
    <AdminProfileCard
      email={email}
      roleLabel={roleLabel}
      colecoesHref="/painel/colecoes"
      onSettings={() => openUserProfile()}
      onSignOut={() => signOut({ redirectUrl: "/" })}
    />
  );
}

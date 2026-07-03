"use client";

import { useClerk } from "@clerk/nextjs";
import { AdminProfileCard } from "@/components/admin/AdminProfileCard";

/**
 * Liga o card de perfil do CLIENTE as acoes reais do Clerk. Renderizado SO quando
 * o Clerk esta configurado (sob o ClerkProvider) — por isso `useClerk()` aqui e
 * seguro; no modo mock-first o layout renderiza o AdminProfileCard direto, sem
 * este wrapper (mesmo padrao do AdminProfileMenu).
 *
 *  - Conta    -> /painel/conta (endereco/dados do cliente; substitui o
 *                "Configurações" do molde admin).
 *  - Coleções -> /painel/colecoes (vitrine dentro do painel).
 *  - Sair     -> signOut e volta para a home.
 */
export function ClienteProfileMenu({ email, roleLabel }: { email: string; roleLabel: string }) {
  const { signOut } = useClerk();
  return (
    <AdminProfileCard
      email={email}
      roleLabel={roleLabel}
      colecoesHref="/painel/colecoes"
      contaHref="/painel/conta"
      onSignOut={() => signOut({ redirectUrl: "/" })}
    />
  );
}

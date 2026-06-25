"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { PageLoader } from "@/components/ui/PageLoader";

// Finaliza o login social no cliente e redireciona pelo roteador de role.
// Enquanto o handshake roda, mostramos o loader de pagina.
export function SSOCallback() {
  return (
    <>
      <AuthenticateWithRedirectCallback
        signInForceRedirectUrl="/pos-login"
        signUpForceRedirectUrl="/pos-login"
      />
      <PageLoader label="Entrando…" />
    </>
  );
}

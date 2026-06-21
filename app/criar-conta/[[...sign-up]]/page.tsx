import { SignUp } from "@clerk/nextjs";
import { AuthShell } from "@/components/layout/AuthShell";
import { AuthPlaceholder } from "@/components/layout/AuthPlaceholder";
import { isClerkConfigured } from "@/lib/services/clerk/config";

export default function CriarContaPage() {
  return (
    <AuthShell>
      {isClerkConfigured() ? (
        // Mesma rota de decisao do login: conta nova (cliente) cai em /minhas-compras;
        // se o e-mail estiver em ADMIN_EMAILS, /pos-login ja manda pro painel.
        <SignUp fallbackRedirectUrl="/pos-login" signInFallbackRedirectUrl="/pos-login" />
      ) : (
        <AuthPlaceholder mode="criar-conta" />
      )}
    </AuthShell>
  );
}

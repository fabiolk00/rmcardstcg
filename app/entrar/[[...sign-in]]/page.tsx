import { SignIn } from "@clerk/nextjs";
import { AuthShell } from "@/components/layout/AuthShell";
import { AuthPlaceholder } from "@/components/layout/AuthPlaceholder";
import { isClerkConfigured } from "@/lib/services/clerk/config";

export default function EntrarPage() {
  return (
    <AuthShell>
      {isClerkConfigured() ? (
        // fallbackRedirectUrl: usado SO quando nao ha redirect_url na query (clique
        // direto em "Entrar"). O roteador /pos-login decide admin -> painel,
        // cliente -> minhas-compras. Deep links de rota protegida (redirect_url do
        // middleware) continuam tendo prioridade e levam de volta ao destino.
        <SignIn fallbackRedirectUrl="/pos-login" signUpFallbackRedirectUrl="/pos-login" />
      ) : (
        <AuthPlaceholder mode="entrar" />
      )}
    </AuthShell>
  );
}

import { AuthShell } from "@/components/layout/AuthShell";
import { AuthPlaceholder } from "@/components/layout/AuthPlaceholder";
import { SignUpForm } from "@/components/auth/SignUpForm";
import { isClerkConfigured } from "@/lib/services/clerk/config";

// Mesmo destino do login: conta nova (cliente) cai em /minhas-compras via
// /pos-login; deep links de rota protegida (redirect_url) tem prioridade.
function resolveRedirect(value: string | string[] | undefined): string {
  const url = Array.isArray(value) ? value[0] : value;
  return url && url.startsWith("/") ? url : "/pos-login";
}

export default async function CriarContaPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const redirectUrl = resolveRedirect((await searchParams).redirect_url);

  return (
    <AuthShell mode="criar-conta">
      {isClerkConfigured() ? (
        <SignUpForm redirectUrl={redirectUrl} />
      ) : (
        <AuthPlaceholder mode="criar-conta" />
      )}
    </AuthShell>
  );
}

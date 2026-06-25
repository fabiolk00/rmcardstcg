import { AuthShell } from "@/components/layout/AuthShell";
import { AuthPlaceholder } from "@/components/layout/AuthPlaceholder";
import { SignInForm } from "@/components/auth/SignInForm";
import { isClerkConfigured } from "@/lib/services/clerk/config";

// Destino pos-login: respeita o redirect_url do middleware (deep link de rota
// protegida) e cai em /pos-login (roteador por role) quando nao houver.
function resolveRedirect(value: string | string[] | undefined): string {
  const url = Array.isArray(value) ? value[0] : value;
  return url && url.startsWith("/") ? url : "/pos-login";
}

export default async function EntrarPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const redirectUrl = resolveRedirect((await searchParams).redirect_url);

  return (
    <AuthShell mode="entrar">
      {isClerkConfigured() ? (
        <SignInForm redirectUrl={redirectUrl} />
      ) : (
        <AuthPlaceholder mode="entrar" />
      )}
    </AuthShell>
  );
}

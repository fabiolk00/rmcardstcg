import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isClerkConfigured } from "@/lib/services/clerk/config";

// Rotas que exigem login. O guard por ROLE de admin (F9) fica no app/admin/layout.
const isProtectedRoute = createRouteMatcher(["/admin(.*)", "/minhas-compras(.*)", "/checkout(.*)"]);

// isClerkConfigured() e avaliado em build-time (NEXT_PUBLIC_* e inlined no bundle).
// Mock-first: sem chave Clerk real, o middleware vira no-op e as rotas protegidas
// (/admin, /minhas-compras) ficam ABERTAS. A protecao so liga com a chave real;
// em producao, faca o build com as chaves Clerk preenchidas.

// Aviso de runtime (nao fatal, p/ nao quebrar o build mock-first do CI): se subir
// em PRODUCAO sem Clerk, as rotas protegidas ficam abertas. Logado uma vez no load.
if (process.env.NODE_ENV === "production" && !isClerkConfigured()) {
  console.error(
    "[middleware] PRODUCAO sem Clerk configurado: /admin, /checkout e /minhas-compras ficam ABERTAS. " +
      "Defina NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY e CLERK_SECRET_KEY.",
  );
}

export default isClerkConfigured()
  ? clerkMiddleware(async (auth, req) => {
      if (isProtectedRoute(req)) await auth.protect();
    })
  : function middleware() {
      return NextResponse.next();
    };

export const config = {
  matcher: [
    // Ignora internos do Next e arquivos estaticos; roda no resto e na API.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    // Caminho de auto-proxy do Clerk (keyless/proxy mode) — precisa rodar pelo middleware.
    "/__clerk/:path*",
  ],
};

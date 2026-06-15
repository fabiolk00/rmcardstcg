import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isClerkConfigured } from "@/lib/services/clerk/config";

// Rotas que exigem login. Guard por ROLE de admin entra no F9.
const isProtectedRoute = createRouteMatcher(["/admin(.*)", "/minhas-compras(.*)", "/checkout(.*)"]);

// isClerkConfigured() e avaliado em build-time (NEXT_PUBLIC_* e inlined no bundle).
// Mock-first: sem chave Clerk real, o middleware vira no-op e as rotas protegidas
// (/admin, /minhas-compras) ficam ABERTAS. A protecao so liga com a chave real;
// em producao, faca o build com as chaves Clerk preenchidas.
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

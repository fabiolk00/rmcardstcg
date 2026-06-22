import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

import { isClerkConfigured } from "@/lib/services/clerk/config";

// Rotas que exigem login. O guard por ROLE de admin (F9) fica no app/admin/layout.
const isProtectedRoute = createRouteMatcher(["/admin(.*)", "/minhas-compras(.*)", "/checkout(.*)"]);

// Middleware Clerk PADRAO (Edge runtime), SEMPRE como `export default` na forma
// canonica — Edge-safe. O que quebrava o bundle Edge na Vercel ("Edge Function
// referencing unsupported modules") era o TERNARIO no export default
// (`isClerkConfigured() ? clerkMiddleware(...) : noop`), NAO um `if` dentro do
// callback. Por isso o protect e gated por isClerkConfigured() AQUI, no fluxo por
// request: em producao as chaves Clerk existem (true) e auth.protect() roda normal;
// mock-first (sem Clerk, dev/harness) o protect e pulado e a rota abre — espelhando o
// fail-closed de app/admin/layout.tsx e lib/auth/requireAdmin.ts (liberam dev, fecham
// producao). isClerkConfigured so le process.env + atob, sem nada Edge-unsafe.
export default clerkMiddleware(async (auth, req) => {
  if (isClerkConfigured() && isProtectedRoute(req)) await auth.protect();
});

export const config = {
  matcher: [
    // Ignora internos do Next e arquivos estaticos; roda no resto e na API.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    // Caminho de auto-proxy do Clerk (keyless/proxy mode) — precisa rodar pelo middleware.
    "/__clerk/:path*",
  ],
};

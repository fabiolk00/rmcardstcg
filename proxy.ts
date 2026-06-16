import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Rotas que exigem login. O guard por ROLE de admin (F9) fica no app/admin/layout.
const isProtectedRoute = createRouteMatcher(["/admin(.*)", "/minhas-compras(.*)", "/checkout(.*)"]);

// Middleware Clerk PADRAO (Edge runtime). Antes era condicional
// (`isClerkConfigured() ? clerkMiddleware(...) : noop`, mock-first sem Clerk), mas
// o ternario no `export default` quebrava o bundle Edge na Vercel ("Edge Function
// referencing unsupported modules" @clerk #safe-node-apis). Como producao sempre tem
// as chaves Clerk, usamos a forma canonica direta — que e Edge-safe.
export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) await auth.protect();
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

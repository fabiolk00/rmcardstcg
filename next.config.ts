import type { NextConfig } from "next";

// Cabecalhos de seguranca HTTP aplicados a TODAS as respostas (defesa em
// profundidade — complementa Clerk/RLS/rate-limit, nao os substitui).
//
// Duas camadas de CSP:
//  1. ENFORCE (`Content-Security-Policy`): so o subconjunto ZERO-RISCO
//     (`frame-ancestors`/`base-uri`/`object-src`/`form-action`) — NAO mexe em
//     `script-src`/`img-src`/`connect-src`, entao nao pode quebrar Clerk/Supabase.
//  2. REPORT-ONLY (`Content-Security-Policy-Report-Only`): a policy candidata
//     COMPLETA, incluindo `script-src`/`connect-src`/`img-src`. Report-Only NAO
//     bloqueia nada — o browser so REPORTA (DevTools console) o que seria barrado.
//     E o jeito seguro de validar os dominios reais antes de promover a enforce:
//     Clerk roda em modo proxy (`/__clerk/*` no proxy.ts) -> a Frontend API e
//     same-origin ('self'); o JS/avatars do Clerk vem de *.clerk.accounts.dev /
//     *.clerk.com / img.clerk.com, e o Turnstile de challenges.cloudflare.com; o
//     Supabase Storage (imagens) de *.supabase.co. Promover a enforce SO depois de
//     um passo manual por login+checkout+upload-admin com DevTools aberto sem
//     violacoes legitimas (ver AUDIT.md).
const securityHeaders = [
  // Clickjacking: ninguem pode embutir o site em iframe de outra origem.
  // frame-ancestors (CSP) supera o X-Frame-Options em browsers modernos; mantem
  // os dois para cobrir browsers antigos.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  {
    key: "Content-Security-Policy",
    value: [
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
    ].join("; "),
  },
  // MIME-sniffing off: o browser respeita o Content-Type declarado.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // HSTS: forca HTTPS por 2 anos, inclui subdominios e habilita preload.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Nao vaza o path completo do referer para outras origens.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Desliga APIs poderosas que o app nao usa.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  // Policy CANDIDATA em modo Report-Only (nao bloqueia; so reporta violacoes no
  // console). Trial p/ virar enforce depois de validada. 'unsafe-inline' em
  // script-src e necessario porque o Next (App Router) injeta scripts inline de
  // hidratacao sem nonce; 'unsafe-eval' fica DE FORA (prod nao precisa — se algo
  // exigir, aparece no relatorio). Clerk em proxy mode -> Frontend API e 'self'.
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://*.supabase.co https://img.clerk.com https://*.clerk.com",
      "font-src 'self' data:",
      "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://clerk-telemetry.com https://*.supabase.co",
      "frame-src 'self' https://challenges.cloudflare.com https://*.clerk.accounts.dev https://*.clerk.com",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // MVP: sem otimizacao de imagem (evita config de remotePatterns/SVG agora).
  // Com unoptimized=true o next/image renderiza qualquer src (local OU a URL
  // publica do Supabase Storage) sem precisar de allowlist de dominio.
  images: { unoptimized: true },
  experimental: {
    // Upload de imagem de produto via server action: o corpo (multipart) traz o
    // arquivo. O default e 1 MB; subimos para acomodar imagens ate ~4 MB (abaixo
    // do teto de 4,5 MB da serverless da Vercel).
    serverActions: { bodySizeLimit: "5mb" },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;

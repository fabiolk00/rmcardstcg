/**
 * Configuracao canonica do site — usada por metadata/SEO (Open Graph, JSON-LD,
 * canonical). A URL base vem de NEXT_PUBLIC_SITE_URL; sem ela, cai para o dominio
 * de producao. Sufixo de barra removido para concatenacao previsivel.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://rmcardstcg.com.br").replace(
  /\/+$/,
  "",
);

export const SITE_NAME = "RM Cards";

/**
 * Nota media "de vitrine" exibida no hero e no cabecalho de colecoes. E um numero
 * de marketing fixo (seed) — NAO a media computada das avaliacoes, que hoje ficam
 * ocultas pela flag NEXT_PUBLIC_REVIEWS_ENABLED e cairia para 0.0 com o catalogo
 * populado via /admin. Fonte unica para hero e colecoes nao divergirem.
 */
export const FEATURED_AVG_RATING = "4.9";

/**
 * Resolve um caminho (relativo, ex.: "/products/x.png") ou uma URL ja absoluta
 * (ex.: a URL publica do Supabase Storage) para uma URL absoluta sob SITE_URL.
 * OG/JSON-LD exigem URLs absolutas; imagens locais precisam do host na frente.
 */
export function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${SITE_URL}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

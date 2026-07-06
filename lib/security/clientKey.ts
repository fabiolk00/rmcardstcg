// Chave de rate limit por-ATOR (usuario autenticado ou IP), centralizada.
//
// Antes triplicada, identica, em 3 server actions (carrinho, produto,
// minhas-compras). Fonte unica agora — DRY + hardening defense-in-depth na
// derivacao do IP anonimo.
//
// SOURCE-PRIORITY do IP anonimo: `x-real-ip` > leftmost de `x-forwarded-for`.
//   - Na Vercel os DOIS carregam o MESMO IP real do cliente (a plataforma
//     sobrescreve o x-forwarded-for e nao encaminha IPs externos — o valor
//     reivindicado pelo cliente nao passa; ver vercel.com/docs/headers/request-headers),
//     entao preferir x-real-ip NAO muda a chave em producao hoje: o contrato
//     (u:<id> / ip:<ip> / anon) e byte-identico ao anterior e nenhum bucket desloca.
//   - x-real-ip e um valor UNICO confiavel (sem CSV pra parsear); preferi-lo torna
//     o codigo robusto se a topologia mudar (sair da Vercel, proxy custom, multi-
//     region) — nesse cenario o leftmost do x-forwarded-for passaria a ser
//     reivindicado pelo cliente (anti-pattern OWASP), enquanto o hop confiavel
//     continua em x-real-ip. Por isso a precedencia, nao a concatenacao.
//   - NAO usamos @vercel/functions (getIP) de proposito: ele exige um objeto Request,
//     e estas server actions derivam o request via next/headers() — sem Request em
//     maos. Header-based cobre o mesmo com zero dependencia nova.

import { headers } from "next/headers";

/**
 * Deriva o IP do cliente de uma lista de headers, com source-priority
 * `x-real-ip` > leftmost `x-forwarded-for`. Puro (testavel sem escopo de request).
 * Retorna `null` se nenhuma fonte confiavel estiver presente.
 */
export function deriveClientIp(headerList: Headers): string | null {
  const realIp = headerList.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = headerList.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return null;
}

/**
 * Monta a chave de rate limit a partir do userId e do IP ja derivado. Puro.
 * - autenticado (userId !== "guest") => `u:<id>` (nao forjavel; exige conta Clerk,
 *   e o IP e IGNORADO — a identidade vence a rede)
 * - anonimo com IP => `ip:<ip>`
 * - sem nada (fora de escopo de request, ex.: teste) => "anon"
 */
export function clientKeyFromParts(userId: string, ip: string | null): string {
  if (userId !== "guest") return `u:${userId}`;
  if (ip) return `ip:${ip}`;
  return "anon";
}

/**
 * Chave de rate limit por-ator (defense-in-depth). Usuario autenticado quando ha
 * Clerk (nunca toca em headers); senao o IP do request (source-priority acima).
 * headers() so existe em escopo de request — fora dele (testes) cai em "anon".
 */
export async function clientRateLimitKey(userId: string): Promise<string> {
  if (userId !== "guest") return `u:${userId}`;
  try {
    return clientKeyFromParts(userId, deriveClientIp(await headers()));
  } catch {
    // fora de escopo de request (ex.: teste)
    return "anon";
  }
}

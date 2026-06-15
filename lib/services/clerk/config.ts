/**
 * Clerk e mock-first: so e ativado quando ha uma publishable key REAL.
 *
 * Uma chave real do Clerk e "pk_test_<base64>" ou "pk_live_<base64>", onde o
 * base64 decodifica para o dominio do frontend terminando em "$". Chave vazia
 * (dev sem segredo) ou placeholder de CI nao passam nessa checagem, entao o app
 * roda sem Clerk e nada quebra (inclusive o build do CI).
 *
 * Usa atob para funcionar em todos os runtimes (Edge/middleware, server, client).
 */
export function isClerkConfigured(): boolean {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!key) return false;

  const match = /^pk_(test|live)_(.+)$/.exec(key);
  if (!match) return false;

  try {
    return atob(match[2]).endsWith("$");
  } catch {
    return false;
  }
}

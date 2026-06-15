/**
 * Bootstrap de admin sem mexer no banco: e-mails listados em ADMIN_EMAILS
 * (separados por virgula) viram role "admin" ao sincronizar pelo webhook e no
 * fallback do guard. Sem a env, ninguem e admin por e-mail (so via DB).
 *
 * Server-only: nao expor ADMIN_EMAILS ao client (sem prefixo NEXT_PUBLIC).
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = process.env.ADMIN_EMAILS;
  if (!list) return false;

  const allow = list
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.toLowerCase());
}

// Extrai uma mensagem amigavel de um erro do Clerk. A API de signals retorna um
// ClerkError ({ message, longMessage, code }); fluxos antigos lancam { errors: [] }.
// Cobre os dois formatos e cai num texto generico quando nada bate.
const FALLBACK = "Não foi possível concluir agora. Tente novamente.";

export function clerkError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as {
      longMessage?: unknown;
      message?: unknown;
      errors?: Array<{ longMessage?: string; message?: string }>;
    };
    if (Array.isArray(e.errors) && e.errors[0]) {
      return e.errors[0].longMessage || e.errors[0].message || FALLBACK;
    }
    if (typeof e.longMessage === "string" && e.longMessage) return e.longMessage;
    if (typeof e.message === "string" && e.message) return e.message;
  }
  return FALLBACK;
}

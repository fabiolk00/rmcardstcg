/**
 * Resend e mock-first: so envia quando ha RESEND_API_KEY e RESEND_FROM_EMAIL.
 * Sem chave (dev/CI), os envios viram no-op e nada quebra.
 *
 * Segredo so no server (sem prefixo NEXT_PUBLIC).
 */
export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

export function getResendConfig(): { apiKey: string; from: string } {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("Resend nao configurado — defina RESEND_API_KEY e RESEND_FROM_EMAIL.");
  }
  return { apiKey, from };
}

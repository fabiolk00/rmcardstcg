/**
 * Configuracao do Supabase Storage — usada no SERVIDOR para o upload de imagens de
 * produto (admin). Mock-first, como Asaas/Clerk: sem as envs o upload fica desligado
 * e a server action devolve erro amigavel; nada quebra no build/dev sem segredo.
 *
 * Reaproveita as envs Supabase ja existentes:
 *  - NEXT_PUBLIC_SUPABASE_URL: a URL do projeto (publica; as URLs publicas dos
 *    arquivos derivam dela). Lida no server mesmo sendo NEXT_PUBLIC.
 *  - SUPABASE_SERVICE_ROLE_KEY: chave server-only (acesso total, ignora RLS) usada
 *    para gravar no bucket. NUNCA prefixar com NEXT_PUBLIC.
 *  - SUPABASE_STORAGE_BUCKET (opcional): nome do bucket; default "tcg".
 */
export type SupabaseStorageConfig = {
  url: string;
  serviceRoleKey: string;
  bucket: string;
};

const DEFAULT_BUCKET = "tcg";

/** true quando ha URL do projeto e service-role key no ambiente. */
export function isSupabaseStorageConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Config do Storage; lanca se chamada sem o ambiente configurado. */
export function getSupabaseStorageConfig(): SupabaseStorageConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase Storage nao configurado — defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return {
    // Remove barra final para concatenar caminhos com seguranca.
    url: url.replace(/\/$/, ""),
    serviceRoleKey,
    bucket: process.env.SUPABASE_STORAGE_BUCKET?.trim() || DEFAULT_BUCKET,
  };
}

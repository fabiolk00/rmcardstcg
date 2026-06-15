/**
 * Configuracao do Asaas (gateway de pagamento) — lida em runtime, no servidor.
 *
 * Mock-first (como o Clerk em lib/services/clerk/config): sem ASAAS_API_KEY o
 * checkout ainda cria o pedido, mas nao gera cobranca PIX (pix: null). A cobranca
 * so liga quando a chave real estiver no ambiente.
 *
 * IMPORTANTE: a chave do Asaas comeca com "$". No .env ela precisa ser escapada
 * como "\$..." senao o dotenv-expand do Next a interpreta como variavel e carrega
 * vazia. Ver comentario no .env / .env.example.
 */
export type AsaasConfig = {
  apiUrl: string;
  apiKey: string;
};

/** true quando ha URL e chave de API do Asaas no ambiente. */
export function isAsaasConfigured(): boolean {
  return Boolean(process.env.ASAAS_API_URL && process.env.ASAAS_API_KEY);
}

/** Config do Asaas; lanca se chamada sem o ambiente configurado. */
export function getAsaasConfig(): AsaasConfig {
  const apiUrl = process.env.ASAAS_API_URL;
  const apiKey = process.env.ASAAS_API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("Asaas nao configurado — defina ASAAS_API_URL e ASAAS_API_KEY.");
  }
  // Remove barra final para concatenar caminhos com seguranca.
  return { apiUrl: apiUrl.replace(/\/$/, ""), apiKey };
}

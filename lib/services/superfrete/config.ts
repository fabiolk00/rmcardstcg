/**
 * Configuracao do SuperFrete (agregador de frete) — lida em runtime, no servidor.
 *
 * Mock-first (como Asaas/Clerk): sem SUPERFRETE_TOKEN + SUPERFRETE_FROM_CEP a cotacao
 * fica DESLIGADA e o checkout cai no frete flat (lib/cart/shipping). A cotacao real
 * so liga quando o token (POR AMBIENTE: sandbox/producao) e o CEP de origem estiverem
 * no ambiente.
 *
 * Auth: header `Authorization: Bearer <token>`. A API tambem EXIGE um `User-Agent`
 * identificando a aplicacao + contato (SUPERFRETE_USER_AGENT).
 */
export type SuperFreteConfig = {
  apiUrl: string;
  token: string;
  userAgent: string;
  /** CEP de origem da loja (so digitos) — o "from" da cotacao. */
  fromCep: string;
};

const DEFAULT_API_URL = "https://sandbox.superfrete.com";
const DEFAULT_USER_AGENT = "RM Cards (contato@rmcardstcg.com.br)";

const onlyDigits = (s: string) => s.replace(/\D/g, "");

// Limites de VALOR DECLARADO (seguro) aceitos pelo provedor, em centavos Int.
// CONFIRMADOS no sandbox real (2026-07-01): piso R$ 24,50 (abaixo disso TODAS as
// modalidades voltam como item-erro "abaixo do limite minimo"; no piso o premio
// observado e zero) e teto POR MODALIDADE (PAC R$ 3.000, SEDEX R$ 10.000 — o
// provedor segrega a modalidade que estoura, em 200). O clamp local usa o teto
// GLOBAL (SEDEX): declarar acima so derrubaria as duas. Ajustaveis por env se a
// tabela do provedor mudar — nunca hardcode o valor no fluxo.
const DEFAULT_INSURANCE_MIN_CENTS = 2450;
const DEFAULT_INSURANCE_MAX_CENTS = 1_000_000;

export type InsuranceLimits = { minCents: number; maxCents: number };

/** Piso/teto de valor declarado (centavos), com override por env. */
export function getInsuranceLimits(): InsuranceLimits {
  const min = Number(process.env.SUPERFRETE_INSURANCE_MIN_CENTS);
  const max = Number(process.env.SUPERFRETE_INSURANCE_MAX_CENTS);
  return {
    minCents: Number.isInteger(min) && min >= 0 ? min : DEFAULT_INSURANCE_MIN_CENTS,
    maxCents: Number.isInteger(max) && max > 0 ? max : DEFAULT_INSURANCE_MAX_CENTS,
  };
}

/** true quando ha token e CEP de origem — o minimo para cotar. */
export function isSuperFreteConfigured(): boolean {
  return Boolean(process.env.SUPERFRETE_TOKEN && process.env.SUPERFRETE_FROM_CEP);
}

/** Config do SuperFrete; lanca se chamada sem o ambiente configurado. */
export function getSuperFreteConfig(): SuperFreteConfig {
  const token = process.env.SUPERFRETE_TOKEN;
  const fromCep = process.env.SUPERFRETE_FROM_CEP;
  if (!token || !fromCep) {
    throw new Error("SuperFrete nao configurado — defina SUPERFRETE_TOKEN e SUPERFRETE_FROM_CEP.");
  }
  return {
    // Remove barra final para concatenar caminhos com seguranca.
    apiUrl: (process.env.SUPERFRETE_API_URL || DEFAULT_API_URL).replace(/\/$/, ""),
    token,
    userAgent: process.env.SUPERFRETE_USER_AGENT || DEFAULT_USER_AGENT,
    fromCep: onlyDigits(fromCep),
  };
}

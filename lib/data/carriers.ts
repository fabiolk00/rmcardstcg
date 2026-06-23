/**
 * Transportadoras de envio — funcao PURA (sem DB), testavel por unidade.
 *
 * O admin escolhe um id de transportador ao despachar; o detalhe do pedido monta o
 * link de rastreio a partir do id + codigo. URLs de rastreio sao as paginas publicas
 * conhecidas (best-effort); "outro" nao tem link (so exibe o codigo). Adicionar uma
 * transportadora = uma linha aqui (id + label + template de URL, ou null).
 */
export type CarrierId = "correios" | "jadlog" | "loggi" | "azul" | "outro";

type CarrierDef = {
  id: CarrierId;
  label: string;
  /** Monta a URL publica de rastreio; null = sem link (so codigo). */
  trackingUrl: ((code: string) => string) | null;
};

export const CARRIERS: readonly CarrierDef[] = [
  {
    id: "correios",
    label: "Correios",
    trackingUrl: (c) => `https://rastreamento.correios.com.br/app/index.php?objeto=${c}`,
  },
  { id: "jadlog", label: "Jadlog", trackingUrl: (c) => `https://www.jadlog.com.br/tracking/${c}` },
  { id: "loggi", label: "Loggi", trackingUrl: (c) => `https://www.loggi.com/rastreador/${c}` },
  {
    id: "azul",
    label: "Azul Cargo",
    trackingUrl: (c) => `https://www.azulcargoexpress.com.br/Rastreamento/${c}`,
  },
  { id: "outro", label: "Outro", trackingUrl: null },
] as const;

const BY_ID = new Map(CARRIERS.map((c) => [c.id, c]));

/** true se o valor e um id de transportador conhecido. */
export function isCarrierId(value: unknown): value is CarrierId {
  return typeof value === "string" && BY_ID.has(value as CarrierId);
}

/** Rotulo do transportador; o proprio valor (capitalizado) se desconhecido. */
export function carrierLabel(id: string | null): string {
  if (!id) return "—";
  return BY_ID.get(id as CarrierId)?.label ?? id;
}

/**
 * URL publica de rastreio (encoda o codigo). null quando: sem id, sem codigo,
 * transportador desconhecido, ou transportador sem template ("outro").
 */
export function carrierTrackingUrl(id: string | null, code: string | null): string | null {
  if (!id || !code) return null;
  const def = BY_ID.get(id as CarrierId);
  if (!def || !def.trackingUrl) return null;
  return def.trackingUrl(encodeURIComponent(code.trim()));
}

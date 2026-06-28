import { fetchQuote, parseQuote, type FetchedQuote, type QuoteItem } from "./quote";

/**
 * Adapter de REGISTRO NORMALIZADO da cotacao, plano e tabular, pronto para um pipeline
 * de dados. UMA linha por modalidade/transportadora retornada (cotavel OU indisponivel
 * — segregadas pelo flag `available`, nunca descartadas). Sem objetos aninhados: cada
 * campo e escalar para casar com tabela/colunar (BigQuery, Parquet, CSV...).
 *
 * Metricas distintas (exigencia do dominio): `quotedPriceCents` e o VALOR COTADO; a
 * transportadora reconfere peso/medidas na postagem e gera credito/debito, entao o
 * VALOR POS-CONFERENCIA (`postAuditPriceCents`) e uma metrica SEPARADA — sempre null na
 * cotacao, preenchida depois pelo evento de postagem. Nunca confundir as duas.
 *
 * PII: o registro carrega CEP de origem/destino (dado dimensional necessario ao
 * pipeline), mas isso NUNCA e logado pelo cliente (./client mascara e nao loga CEP).
 */
export type ShippingQuoteRecord = {
  // --- correlacao / metadados da chamada ---
  /** id da requisicao (correlaciona com a linha de log [superfrete]). */
  requestId: string;
  /**
   * Indice 0-based da linha DENTRO desta cotacao. (requestId, rowIndex) e a chave de
   * linha unica e estavel — serviceCode pode repetir ou ser 0 (sentinel), entao NAO
   * sirva de chave. Ordem deterministica: cotaveis (preco asc) e depois indisponiveis.
   */
  rowIndex: number;
  /**
   * ISO-8601 de quando o registro foi MATERIALIZADO (nao necessariamente o instante da
   * chamada externa): num cache-hit (cacheHit=true) a cotacao real pode ter ocorrido
   * antes — use requestId/cacheHit para reconciliar a idade real ao particionar por tempo.
   */
  quotedAt: string;
  httpStatus: number;
  latencyMs: number;
  attempts: number;
  cacheHit: boolean;
  // --- rota / pacote (dimensional) ---
  fromCep: string;
  toCep: string;
  totalWeightKg: number;
  itemCount: number;
  // --- modalidade ---
  serviceCode: number;
  carrier: string | null;
  serviceName: string;
  available: boolean;
  unavailableReason: string | null;
  // --- metricas (centavos Int) ---
  /** VALOR COTADO (ja com desconto da transportadora). null se indisponivel. */
  quotedPriceCents: number | null;
  /** VALOR POS-CONFERENCIA — distinto do cotado; null ate o evento de postagem. */
  postAuditPriceCents: number | null;
  deliveryDays: number | null;
};

/**
 * Transforma uma cotacao crua (corpo + meta + contexto) em registros normalizados.
 * PURO e sem rede: o `quotedAt` e injetavel para teste deterministico (default = agora).
 */
export function toQuoteRecords(fetched: FetchedQuote, quotedAt?: string): ShippingQuoteRecord[] {
  const { raw, meta, cacheHit, context } = fetched;
  const at = quotedAt ?? new Date().toISOString();
  const base = {
    requestId: meta.requestId,
    quotedAt: at,
    httpStatus: meta.status,
    latencyMs: meta.latencyMs,
    attempts: meta.attempts,
    cacheHit,
    fromCep: context.fromCep,
    toCep: context.toCep,
    totalWeightKg: context.totalWeightKg,
    itemCount: context.itemCount,
  };

  const { options, unavailable } = parseQuote(raw);
  const records: ShippingQuoteRecord[] = [];

  for (const o of options) {
    records.push({
      ...base,
      rowIndex: records.length,
      serviceCode: o.serviceCode,
      carrier: o.carrier,
      serviceName: o.name,
      available: true,
      unavailableReason: null,
      quotedPriceCents: o.priceCents,
      postAuditPriceCents: null,
      deliveryDays: o.days,
    });
  }
  for (const u of unavailable) {
    records.push({
      ...base,
      rowIndex: records.length,
      serviceCode: u.serviceCode,
      carrier: u.carrier,
      serviceName: u.name,
      available: false,
      unavailableReason: u.reason,
      quotedPriceCents: null,
      postAuditPriceCents: null,
      deliveryDays: null,
    });
  }
  return records;
}

/**
 * Cota o frete e devolve o REGISTRO NORMALIZADO (uma linha por modalidade, cotaveis e
 * indisponiveis segregadas), pronto para um pipeline de dados. [] = nao cotavel
 * (mock-first / CEP invalido / sem itens) — o chamador decide o fallback. Reusa o
 * nucleo de cotacao (fetchQuote: retry + cache + observabilidade).
 */
export async function quoteShippingRecords(
  toCep: string,
  items: QuoteItem[],
): Promise<ShippingQuoteRecord[]> {
  const fetched = await fetchQuote(toCep, items);
  if (!fetched) return [];
  return toQuoteRecords(fetched);
}

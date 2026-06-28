import { getSuperFreteConfig, isSuperFreteConfigured } from "./config";
import { superFreteRequest, type SuperFreteCallMeta } from "./client";
import { cacheGet, cacheSet, quoteCacheKey } from "./cache";
import type { PackageDims } from "./dimensions";

/**
 * Cotacao de frete via SuperFrete (POST /api/v0/calculator).
 *
 * Mock-first: sem o ambiente configurado (ou CEP/itens invalidos) devolve [] — o
 * chamador cai no frete flat (lib/cart/shipping). Manda a lista de `products` (um por
 * linha do carrinho, com as medidas EFETIVAS do produto — ver effectivePackage), entao
 * a CUBAGEM (consolidacao do pacote) e feita pelo SuperFrete.
 *
 * NOTA de contrato: a doc oficial bloqueia acesso automatizado; o payload usa
 * `products[]` (array, com cubagem no SuperFrete) em vez do `package` unico — e
 * capacidade documentada da API e o formato certo para carrinho multi-linha. Valide
 * com uma chamada real ao sandbox (tests/shipping/superfrete-sandbox.integration.test.ts).
 *
 * Resiliencia/observabilidade ficam no cliente de baixo nivel (./client): a cotacao e
 * READ-ONLY/idempotente, entao opta por `retry: true` (timeout/5xx/429 re-tentam). O
 * cache (./cache) e opt-in por TTL e atende tanto a versao "so opcoes" (checkout)
 * quanto o registro normalizado (pipeline de dados), sem repetir a chamada externa.
 */

// 1=PAC, 2=SEDEX (17=Mini Envios, 3=Jadlog, 31=Loggi disponiveis se quiser ampliar).
const SHIPPING_SERVICES = "1,2";

/** Uma linha do carrinho para cotacao: quantidade + medidas do pacote. */
export type QuoteItem = { quantity: number; pkg: PackageDims };

/** Modalidade COTAVEL (tem preco valido). 0 = fallback flat. */
export type ShippingOption = {
  /** Codigo do servico no SuperFrete (1=PAC, 2=SEDEX, ...). 0 = fallback flat. */
  serviceCode: number;
  name: string;
  /** Transportadora (company.name), quando a API informar. */
  carrier: string | null;
  priceCents: number;
  /** Prazo em dias uteis; null se a API nao informar. */
  days: number | null;
};

/**
 * Modalidade INDISPONIVEL: vem no array da resposta com um campo de erro EM VEZ de
 * preco. NAO some do array — precisa ser segregada (nao descartada), para o pipeline
 * registrar a rota/transportadora sem cotacao.
 */
export type UnavailableModality = {
  serviceCode: number;
  name: string;
  carrier: string | null;
  reason: string;
};

/** Resultado parseado: cotaveis separadas das indisponiveis. */
export type ParsedQuote = {
  options: ShippingOption[];
  unavailable: UnavailableModality[];
};

type RawCompany = { name?: string };
type RawOption = {
  id?: number;
  name?: string;
  price?: string | number;
  delivery_time?: number;
  error?: string;
  company?: RawCompany;
};

const onlyDigits = (s: string) => s.replace(/\D/g, "");

/**
 * Converte preco -> centavos Int; null se invalido/<=0. Aceita numero ou string em
 * formato BR ("1.234,56", "10,00") ou US/ISO ("23.50", "1,234.56"): o ULTIMO separador
 * e o decimal e o outro e milhar (removido). Assim um preco >= R$1.000 com separador de
 * milhar nao vira NaN -> "indisponivel" por engano. Tolera variacao de formato do provedor.
 */
function priceToCents(price: string | number | undefined): number | null {
  let n: number;
  if (typeof price === "string") {
    let s = price.trim();
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    } else if (lastComma >= 0) {
      s = s.replace(",", "."); // so virgula => decimal BR
    }
    n = Number(s);
  } else {
    n = Number(price);
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/** Prazo em dias uteis (>0) ou null. */
function deliveryDays(raw: number | undefined): number | null {
  const d = Number(raw);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * Classifica UM item do array bruto em cotavel vs indisponivel. Fonte unica das regras
 * de parse (reusada por parseQuote e pelo adapter de registro): um item e indisponivel
 * se traz `error` OU nao tem preco valido.
 */
function classifyRawItem(
  item: RawOption,
): { available: true; option: ShippingOption } | { available: false; modality: UnavailableModality } {
  const serviceCode = Number(item?.id) || 0;
  const name = item?.name ?? "Frete";
  const carrier = item?.company?.name ?? null;
  const priceCents = priceToCents(item?.price);
  if (item?.error || priceCents === null) {
    return {
      available: false,
      modality: { serviceCode, name, carrier, reason: item?.error ?? "Sem preco disponivel." },
    };
  }
  return {
    available: true,
    option: { serviceCode, name, carrier, priceCents, days: deliveryDays(item?.delivery_time) },
  };
}

/**
 * Parser PURO da resposta do calculator: SEGREGA modalidades cotaveis das
 * indisponiveis (nao quebra com item-erro). Cotaveis ordenadas do mais barato ao mais
 * caro. Exportado para teste sem rede.
 */
export function parseQuote(raw: unknown): ParsedQuote {
  if (!Array.isArray(raw)) return { options: [], unavailable: [] };
  const options: ShippingOption[] = [];
  const unavailable: UnavailableModality[] = [];
  for (const item of raw as RawOption[]) {
    const c = classifyRawItem(item ?? {});
    if (c.available) options.push(c.option);
    else unavailable.push(c.modality);
  }
  options.sort((a, b) => a.priceCents - b.priceCents);
  return { options, unavailable };
}

/**
 * Compat: so as modalidades cotaveis, ordenadas. Mantida para o checkout (que so
 * precisa das opcoes com preco). Reusa parseQuote — fonte unica das regras.
 */
export function parseShippingOptions(raw: unknown): ShippingOption[] {
  return parseQuote(raw).options;
}

/**
 * Monta o `products[]` do payload (cubagem no SuperFrete) a partir das linhas do
 * carrinho. Peso em GRAMAS -> KG (a API espera kg); dimensoes em CM.
 */
export function buildProductsPayload(items: QuoteItem[]) {
  return items
    .filter((i) => Number.isInteger(i.quantity) && i.quantity > 0)
    .map((i) => ({
      quantity: i.quantity,
      weight: i.pkg.weightGrams / 1000,
      height: i.pkg.heightCm,
      width: i.pkg.widthCm,
      length: i.pkg.lengthCm,
    }));
}

/** Contexto dimensional da cotacao (alimenta o registro normalizado). */
export type QuoteContext = {
  fromCep: string;
  toCep: string;
  services: string;
  totalWeightKg: number;
  itemCount: number;
};

/** Resposta crua + metadados + contexto de UMA cotacao (consumida por options e records). */
export type FetchedQuote = {
  raw: unknown;
  meta: SuperFreteCallMeta;
  cacheHit: boolean;
  context: QuoteContext;
};

type CachedQuote = { raw: unknown; meta: SuperFreteCallMeta };

/**
 * Nucleo da cotacao: valida ambiente/CEP/itens, consulta o cache (opt-in), chama o
 * SuperFrete (com retry, pois e idempotente) e devolve corpo + meta + contexto.
 * null => nao cotavel (mock-first / CEP invalido / sem itens) -> chamador cai no flat.
 */
export async function fetchQuote(toCep: string, items: QuoteItem[]): Promise<FetchedQuote | null> {
  if (!isSuperFreteConfigured()) return null;
  const dest = onlyDigits(toCep);
  if (dest.length !== 8) return null;
  const products = buildProductsPayload(items);
  if (products.length === 0) return null;

  const { fromCep } = getSuperFreteConfig();
  const context: QuoteContext = {
    fromCep,
    toCep: dest,
    services: SHIPPING_SERVICES,
    // Soma em gramas inteiros e divide UMA vez: evita ruido de ponto-flutuante na
    // metrica do registro (consistente com a convencao de centavos Int do dominio).
    totalWeightKg:
      products.reduce((sum, p) => sum + Math.round(p.weight * 1000) * p.quantity, 0) / 1000,
    itemCount: products.reduce((sum, p) => sum + p.quantity, 0),
  };

  // products ja tem o shape { quantity, weight, height, width, length } esperado pela chave.
  const key = quoteCacheKey({ fromCep, toCep: dest, services: SHIPPING_SERVICES, products });

  const cached = cacheGet<CachedQuote>(key);
  if (cached) {
    // Hit nao passa pelo client (logCall), entao emite a propria linha — sem isso a
    // taxa de hit/miss fica cega. Reusa o requestId da chamada original p/ correlacao.
    console.info("[superfrete] cache hit", {
      service: "superfrete",
      requestId: cached.meta.requestId,
      path: "/api/v0/calculator",
      cacheHit: true,
    });
    return { raw: cached.raw, meta: cached.meta, cacheHit: true, context };
  }

  const { data, meta } = await superFreteRequest<unknown>("/api/v0/calculator", {
    method: "POST",
    retry: true,
    body: JSON.stringify({
      from: { postal_code: fromCep },
      to: { postal_code: dest },
      services: SHIPPING_SERVICES,
      options: { own_hand: false, receipt: false, use_insurance_value: false },
      products,
    }),
  });
  cacheSet<CachedQuote>(key, { raw: data, meta });
  return { raw: data, meta, cacheHit: false, context };
}

/**
 * Cota o frete para um CEP de destino e as linhas do carrinho. [] = indisponivel
 * (mock-first / CEP invalido / sem opcao cotavel). So as modalidades COM preco — o
 * checkout nao precisa das indisponiveis. Para o registro completo (pipeline de
 * dados) use quoteShippingRecords.
 */
export async function quoteShipping(toCep: string, items: QuoteItem[]): Promise<ShippingOption[]> {
  const fetched = await fetchQuote(toCep, items);
  if (!fetched) return [];
  return parseQuote(fetched.raw).options;
}

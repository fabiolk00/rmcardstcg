import { getInsuranceLimits, getSuperFreteConfig, isSuperFreteConfigured } from "./config";
import { SuperFreteError, superFreteRequest, type SuperFreteCallMeta } from "./client";
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
export type QuoteItem = {
  quantity: number;
  pkg: PackageDims;
  /**
   * Valor unitario da MERCADORIA (centavos Int, ja com desconto — nunca o frete),
   * para o valor declarado/seguro. Opcional: sem valor em nenhum item, o seguro
   * fica desligado (comportamento anterior).
   */
  unitPriceCents?: number;
};

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

/**
 * So digitos. Tolera null/undefined/nao-string: a cotacao e chamada com dados que
 * vem do client (CEP de formulario) e nunca deve quebrar por tipo — CEP ausente
 * simplesmente nao cota (o chamador cai no flat / pede o CEP de novo).
 */
const onlyDigits = (s: unknown) => (typeof s === "string" ? s.replace(/\D/g, "") : "");

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
):
  | { available: true; option: ShippingOption }
  | { available: false; modality: UnavailableModality } {
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
  return (Array.isArray(items) ? items : [])
    .filter((i) => i != null && Number.isInteger(i.quantity) && i.quantity > 0)
    .map((i) => ({
      quantity: i.quantity,
      weight: i.pkg.weightGrams / 1000,
      height: i.pkg.heightCm,
      width: i.pkg.widthCm,
      length: i.pkg.lengthCm,
    }));
}

/**
 * VALOR DECLARADO (centavos Int) do carrinho para o seguro: soma de
 * quantidade x valor unitario da MERCADORIA (nunca o frete), sobre os MESMOS
 * itens que entram no payload (mesmo filtro de quantidade). Clampado ao
 * piso/teto do provedor (config, env-override). 0 = seguro desligado
 * (nenhum item com valor, ou valores invalidos).
 */
export function declaredValueCents(items: QuoteItem[]): number {
  const raw = (Array.isArray(items) ? items : [])
    .filter((i) => i != null && Number.isInteger(i.quantity) && i.quantity > 0)
    .reduce((sum, i) => {
      const unit = i.unitPriceCents;
      return typeof unit === "number" && Number.isInteger(unit) && unit > 0
        ? sum + unit * i.quantity
        : sum;
    }, 0);
  if (raw <= 0) return 0;
  const { minCents, maxCents } = getInsuranceLimits();
  return Math.min(Math.max(raw, minCents), maxCents);
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

  // Seguro: valor declarado da mercadoria (centavos), clampado aos limites do provedor.
  const insuranceCents = declaredValueCents(items);

  // products ja tem o shape { quantity, weight, height, width, length } esperado pela
  // chave. O valor declarado TAMBEM entra na chave: a mesma rota/pacote com seguro
  // diferente tem preco diferente — sem isso um hit serviria a cotacao errada.
  const key = quoteCacheKey({
    fromCep,
    toCep: dest,
    services: SHIPPING_SERVICES,
    products,
    insuranceCents,
  });

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
    // ORCAMENTO DE TEMPO: a cotacao roda dentro do checkout (server action). Com o
    // default (12s x 3 tentativas) o pior caso passava de 36s e estourava o limite
    // de execucao da funcao — o checkout INTEIRO morria por causa do frete. 6s x 2
    // tentativas mantem o pior caso em ~13s, ainda dentro do limite, e o frete
    // degrada para o flat em vez de derrubar a compra.
    timeoutMs: 6_000,
    maxRetries: 1,
    body: JSON.stringify({
      from: { postal_code: fromCep },
      to: { postal_code: dest },
      services: SHIPPING_SERVICES,
      // Seguro (valor declarado): habilitado sempre que ha valor de mercadoria nos
      // itens. `insurance_value` em REAIS — divisao UNICA de centavos Int (sem
      // acumulo de FP). Sem valor (fluxos legados/sem preco) fica off, como antes.
      options: {
        own_hand: false,
        receipt: false,
        use_insurance_value: insuranceCents > 0,
        ...(insuranceCents > 0 ? { insurance_value: insuranceCents / 100 } : {}),
      },
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

/**
 * Resultado CLASSIFICADO da cotacao — a diferenca entre "o provedor disse NAO" e
 * "nao conseguimos perguntar":
 *
 *  - `quoted`      : ha modalidade com preco.
 *  - `unavailable` : o provedor RESPONDEU e nao ha entrega para este CEP/pacote
 *                    (409 de cobertura, todas as modalidades como item-erro, ou
 *                    lista vazia). Vender aqui gera pedido que a etiqueta nao
 *                    emite — o chamador deve BLOQUEAR, nao cair no flat.
 *  - `unquoted`    : nao houve resposta utilizavel (ambiente sem token, entrada
 *                    invalida, timeout/5xx/401). O frete ainda e vendavel pelo
 *                    flat, mas `provider_error` merece alerta: e a loja cotando
 *                    no escuro.
 *
 * Sem essa distincao TODA falha virava o mesmo R$ 25,00 silencioso.
 */
export type QuoteOutcome =
  | { status: "quoted"; options: ShippingOption[] }
  | { status: "unavailable"; reason: string }
  | {
      status: "unquoted";
      cause: "not_configured" | "invalid_input" | "provider_error";
      detail?: string;
    };

/** Mensagens do mapa `errors` do provedor (por campo), achatadas em texto. */
function providerMessages(body: unknown): string[] {
  const errors = (body as { errors?: Record<string, unknown> } | null)?.errors;
  if (!errors || typeof errors !== "object") return [];
  return Object.entries(errors).flatMap(([field, msgs]) =>
    (Array.isArray(msgs) ? msgs : [msgs]).map((m) => `${field}: ${String(m)}`),
  );
}

/**
 * "Nao entregamos ai" NAO tem status dedicado no provedor. CONFIRMADO contra a
 * API de PRODUCAO (2026-07-20): CEP sem cobertura/inexistente volta HTTP **400**
 * com `correios.destination_postcode ... e invalido` e/ou
 * `ms-freight-calculator.no_result` — nao 409. Tratar isso como falha do
 * provedor faria a loja (a) vender frete flat para um destino que ela nao
 * atende e (b) alertar o admin por um erro que e do cliente. O 409 fica coberto
 * por seguranca (documentado, nunca observado nesse caso).
 *
 * Um 400 por payload NOSSO (peso/medida invalidos) nao casa essas assinaturas e
 * continua como provider_error — que e o alerta legitimo.
 */
function noCoverageReason(err: SuperFreteError): string | null {
  if (err.status !== 400 && err.status !== 409) return null;
  const messages = providerMessages(err.body);
  const text = [err.message, ...messages].join(" | ");
  if (err.status === 409) return err.message;
  if (!/destination_postcode|no_result|nenhum frete/i.test(text)) return null;
  return messages.join(" | ") || err.message;
}

export async function quoteShippingResult(
  toCep: string,
  items: QuoteItem[],
): Promise<QuoteOutcome> {
  if (!isSuperFreteConfigured()) return { status: "unquoted", cause: "not_configured" };
  if (onlyDigits(toCep).length !== 8 || buildProductsPayload(items).length === 0) {
    return { status: "unquoted", cause: "invalid_input" };
  }

  let fetched: FetchedQuote | null;
  try {
    fetched = await fetchQuote(toCep, items);
  } catch (err) {
    // Destino fora de cobertura (400 com assinatura de postcode/no_result, ou
    // 409): o provedor respondeu NAO e re-tentar nao muda. Qualquer outro erro e
    // falha nossa/do provedor.
    if (err instanceof SuperFreteError) {
      const reason = noCoverageReason(err);
      if (reason !== null) return { status: "unavailable", reason };
    }
    return {
      status: "unquoted",
      cause: "provider_error",
      detail:
        err instanceof SuperFreteError
          ? `HTTP ${err.status} (requestId ${err.requestId})`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }
  if (!fetched) return { status: "unquoted", cause: "invalid_input" };

  const { options, unavailable } = parseQuote(fetched.raw);
  if (options.length > 0) return { status: "quoted", options };
  return {
    status: "unavailable",
    // Texto cru do provedor quando houver (ex.: "Peso acima do limite"); senao
    // uma razao generica — em ambos os casos o pedido NAO deve ser aceito.
    reason: unavailable[0]?.reason ?? "Nenhuma modalidade de entrega para este CEP.",
  };
}

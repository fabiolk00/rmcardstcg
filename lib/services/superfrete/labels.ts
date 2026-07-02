import { getInsuranceLimits, isSuperFreteConfigured } from "./config";
import { SuperFreteError, superFreteRequest } from "./client";
import type {
  CanceledLabel,
  CreateLabelInput,
  CreatedLabel,
  LabelAddress,
  LabelErrorCode,
  LabelInfo,
  LabelModule,
  LabelStatus,
  PrintFormat,
  PrintedLabel,
  WalletBalance,
} from "./label-types";

/**
 * Modulo de ETIQUETA do SuperFrete — implementa a interface congelada LabelModule
 * (label-types.ts; mapeamento provedor <-> contrato em LABEL-CONTRACT.md).
 *
 * createLabel = cart + checkout, IDEMPOTENTE por externalRef: um LabelStore
 * (injetavel; default em memoria) cataloga o superFreteId de cada referencia e o
 * retry RETOMA de onde parou (cart dedupado; 409 "ja pago" = sucesso idempotente,
 * mas 409 tambem pode ser "sem saldo" — classificado pela mensagem + order/info).
 *
 * Convencoes do dominio: dinheiro em CENTAVOS Int, peso em GRAMAS, dimensoes em CM.
 * A conversao para reais-float/kg-float do provedor acontece SO na borda (divisao
 * unica, sem acumulo de float).
 *
 * SEM fallback flat (diferente da cotacao): emissao sem ambiente configurado e um
 * erro claro ("provider"), nunca um mock silencioso.
 *
 * Resiliencia: GETs (user, order/info) re-tentam via client (retry: true);
 * cart/checkout/print/cancel tem efeito colateral e NUNCA re-tentam no HTTP.
 */

/** Erro tipado do modulo (codes do contrato congelado). */
export class SuperFreteLabelError extends Error {
  readonly code: LabelErrorCode;
  /** Erros por campo — da validacao LOCAL ou do mapa `errors` do provedor (via SuperFreteError.body). */
  readonly fields?: Record<string, string[]>;
  /** id de correlacao da chamada HTTP subjacente, quando houver. */
  readonly requestId: string;

  constructor(
    code: LabelErrorCode,
    message: string,
    fields?: Record<string, string[]>,
    requestId = "",
  ) {
    super(message);
    this.name = "SuperFreteLabelError";
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
  }
}

// ---------------------------------------------------------------------------
// Store de idempotencia (externalRef -> envio no provedor)
// ---------------------------------------------------------------------------

export type LabelStoreEntry = { superFreteId: string; paid: boolean };

/**
 * Persistencia da idempotencia, INJETAVEL (createLabel aceita deps.store): em
 * producao aponte para o banco (ex.: coluna no pedido); o default em memoria vale
 * por instancia (suficiente para retry no mesmo processo e para testes).
 */
export type LabelStore = {
  get(ref: string): Promise<LabelStoreEntry | null>;
  set(ref: string, entry: LabelStoreEntry): Promise<void>;
};

const memoryEntries = new Map<string, LabelStoreEntry>();

const memoryStore: LabelStore = {
  async get(ref) {
    return memoryEntries.get(ref) ?? null;
  },
  async set(ref, entry) {
    memoryEntries.set(ref, entry);
  },
};

/** Limpa o store default em memoria E o memo de concorrencia (uso em teste). */
export function labelStoreClear(): void {
  memoryEntries.clear();
  inflightByRef.clear();
}

// ---------------------------------------------------------------------------
// Conversoes na borda (reais/kg do provedor <-> centavos/gramas do dominio)
// ---------------------------------------------------------------------------

const onlyDigits = (s: string) => s.replace(/\D/g, "");

/**
 * Converte preco -> centavos Int; null se invalido/<=0. COPIA da semantica de
 * priceToCents de quote.ts (privado la — duplicado aqui de proposito, sem editar
 * quote.ts): aceita numero ou string BR ("1.234,56") / US ("1,234.56"); o ULTIMO
 * separador e o decimal e o outro e milhar (removido).
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

/** Saldo da carteira -> centavos Int (zero/negativo sao legitimos aqui, ao contrario de preco). */
function balanceToCents(value: unknown): number {
  const cents = priceToCents(value as string | number | undefined);
  if (cents !== null) return cents;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Inteiro do provedor ou null (limits ausentes em producao). */
function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Numero positivo do provedor; 0 quando ausente/invalido. */
function positiveNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Re-clamp defensivo do valor declarado (mesma semantica da cotacao,
 * quote.declaredValueCents): <= 0 desliga o seguro; senao clamp [piso, teto] do
 * provedor (config, env-override).
 */
function clampDeclared(declaredValueCents: number): number {
  if (!Number.isFinite(declaredValueCents) || declaredValueCents <= 0) return 0;
  const { minCents, maxCents } = getInsuranceLimits();
  return Math.min(Math.max(Math.round(declaredValueCents), minCents), maxCents);
}

// ---------------------------------------------------------------------------
// Status, erros e log
// ---------------------------------------------------------------------------

const LABEL_STATUSES: readonly LabelStatus[] = [
  "pending",
  "released",
  "posted",
  "delivered",
  "canceled",
];

/** Status do provedor SE for um dos conhecidos; null caso contrario (sem warn). */
function knownStatus(raw: unknown): LabelStatus | null {
  return typeof raw === "string" && (LABEL_STATUSES as readonly string[]).includes(raw)
    ? (raw as LabelStatus)
    : null;
}

/** Status do provedor -> LabelStatus; desconhecido degrada para "pending" com warn. */
function mapProviderStatus(raw: unknown): LabelStatus {
  const status = knownStatus(raw);
  if (status) return status;
  console.warn("[superfrete] label status desconhecido do provedor", { status: String(raw) });
  return "pending";
}

/** Mensagens de recusa por rota/modalidade (CEP nao atendido etc.) -> "unavailable". */
function isUnavailableMessage(message: string): boolean {
  return /atendid|indispon|unavailable|unserved/i.test(message);
}

/** Mensagens de saldo/carteira insuficiente -> "insufficient_balance". */
function isBalanceMessage(message: string): boolean {
  return /saldo|insuficiente|insufficient|balance|carteira/i.test(message);
}

/** Mapa `errors` por campo do body de erro do provedor (shape capturado), se houver. */
function providerFieldErrors(body: unknown): Record<string, string[]> | undefined {
  const errors = (body as { errors?: unknown } | null)?.errors;
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [field, msgs] of Object.entries(errors as Record<string, unknown>)) {
    out[field] = Array.isArray(msgs) ? msgs.map(String) : [String(msgs)];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normaliza QUALQUER falha para SuperFreteLabelError (nunca vaza excecao generica).
 * O detalhe do provedor costuma vir no mapa `errors` do body (a message top-level e
 * generica, "Ocorreu um ou mais erros.") — o client propaga o body em
 * SuperFreteError.body, e a classificacao olha TODAS as mensagens: saldo/carteira =>
 * "insufficient_balance"; rota/modalidade recusada => "unavailable"; demais 400 =>
 * "validation" (com fields do provedor); outros status => "provider".
 */
function toLabelError(err: unknown, acao: string): SuperFreteLabelError {
  if (err instanceof SuperFreteLabelError) return err;
  if (err instanceof SuperFreteError) {
    const fields = providerFieldErrors(err.body);
    const allMessages = [err.message, ...Object.values(fields ?? {}).flat()].join(" | ");
    if (isBalanceMessage(allMessages)) {
      return new SuperFreteLabelError("insufficient_balance", allMessages, fields, err.requestId);
    }
    if (err.status === 400) {
      const code: LabelErrorCode = isUnavailableMessage(allMessages) ? "unavailable" : "validation";
      return new SuperFreteLabelError(code, allMessages, fields, err.requestId);
    }
    return new SuperFreteLabelError("provider", err.message, fields, err.requestId);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new SuperFreteLabelError("provider", `Falha inesperada na etiqueta (${acao}): ${message}`);
}

/**
 * UMA linha estruturada por acao com efeito colateral (leituras ja tem a linha do
 * client). NUNCA loga token/CEP/documento — so identificadores de correlacao.
 */
function logLabel(
  acao: "create" | "print" | "cancel",
  fields: { requestId?: string; superFreteId?: string; externalRef?: string; outcome: string },
  ok: boolean,
): void {
  const line = { service: "superfrete", ...fields };
  if (ok) console.info(`[superfrete] label ${acao}`, line);
  else console.error(`[superfrete] label ${acao}`, line);
}

/** Etiqueta NAO tem fallback flat: sem ambiente configurado e erro claro, nao mock. */
function ensureConfigured(): void {
  if (!isSuperFreteConfigured()) {
    throw new SuperFreteLabelError(
      "provider",
      "SuperFrete nao configurado — defina SUPERFRETE_TOKEN e SUPERFRETE_FROM_CEP (etiqueta nao tem fallback flat).",
    );
  }
}

// ---------------------------------------------------------------------------
// Validacao LOCAL (casos 1, 2, 7 e 8 do contrato — falha rapido, sem fetch)
// ---------------------------------------------------------------------------

// Tetos fisicos dos Correios: acima disso o provedor recusaria — nao gasta chamada.
const MAX_WEIGHT_GRAMS = 30_000;
const MAX_DIMENSION_CM = 150;

function validateCreateInput(input: CreateLabelInput): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  const add = (field: string, msg: string) => {
    (fields[field] ??= []).push(msg);
  };

  if (typeof input.externalRef !== "string" || input.externalRef.trim() === "") {
    add("externalRef", "externalRef e obrigatorio (base da idempotencia).");
  }
  if (!Number.isInteger(input.serviceCode) || input.serviceCode <= 0) {
    add("service", "serviceCode deve ser inteiro > 0 (1=PAC, 2=SEDEX).");
  }
  if (onlyDigits(input.from?.postalCode ?? "").length !== 8) {
    add("from.postal_code", "CEP de origem deve ter 8 digitos.");
  }
  if (onlyDigits(input.to?.postalCode ?? "").length !== 8) {
    add("to.postal_code", "CEP de destino deve ter 8 digitos.");
  }
  const doc = onlyDigits(input.to?.document ?? "");
  if (doc.length !== 11 && doc.length !== 14) {
    add("to.document", "CPF/CNPJ do destinatario e obrigatorio (11 ou 14 digitos).");
  }
  if (!Array.isArray(input.items) || input.items.length < 1) {
    add("items", "pelo menos 1 item para a declaracao de conteudo.");
  } else {
    input.items.forEach((item, i) => {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        add(`items[${i}].quantity`, "quantidade deve ser inteiro > 0.");
      }
      if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents <= 0) {
        add(`items[${i}].unitary_value`, "valor unitario deve ser centavos Int > 0.");
      }
    });
  }
  const isPositive = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  if (!isPositive(input.pkg?.weightGrams)) {
    add("volumes.weight", "peso do pacote deve ser > 0.");
  } else if (input.pkg.weightGrams > MAX_WEIGHT_GRAMS) {
    add("volumes.weight", "peso maximo de 30 kg (teto dos Correios).");
  }
  const dims = [
    ["volumes.height", input.pkg?.heightCm],
    ["volumes.width", input.pkg?.widthCm],
    ["volumes.length", input.pkg?.lengthCm],
  ] as const;
  for (const [field, value] of dims) {
    if (!isPositive(value)) add(field, "dimensao do pacote deve ser > 0 cm.");
    else if (value > MAX_DIMENSION_CM) add(field, "dimensao maxima de 150 cm.");
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Payload do /cart (unidades do provedor: kg/cm/reais; strings conforme plugin)
// ---------------------------------------------------------------------------

function toProviderAddress(a: LabelAddress): Record<string, string> {
  const out: Record<string, string> = {
    name: a.name,
    document: onlyDigits(a.document ?? ""),
    address: a.address,
    number: a.number,
    district: a.district,
    city: a.city,
    state_abbr: a.stateAbbr,
    postal_code: onlyDigits(a.postalCode),
  };
  if (a.complement) out.complement = a.complement;
  if (a.email) out.email = a.email;
  if (a.phone) out.phone = a.phone;
  return out;
}

function buildCartPayload(input: CreateLabelInput) {
  const declared = clampDeclared(input.declaredValueCents);
  return {
    from: toProviderAddress(input.from),
    to: toProviderAddress(input.to),
    service: input.serviceCode,
    // Declaracao de conteudo (non_commercial): quantity/unitary_value como STRING,
    // formato do plugin oficial. Divisao UNICA centavos -> reais, por item.
    products: input.items.map((item) => ({
      name: item.name,
      quantity: String(item.quantity),
      unitary_value: (item.unitPriceCents / 100).toFixed(2),
    })),
    // Pacote UNICO consolidado (o MESMO da cotacao): g -> kg (divisao unica), cm direto.
    volumes: {
      height: input.pkg.heightCm,
      width: input.pkg.widthCm,
      length: input.pkg.lengthCm,
      weight: input.pkg.weightGrams / 1000,
    },
    options: {
      // Seguro em REAIS na borda; 0 = sem seguro (o contrato manda enviar 0 mesmo).
      insurance_value: declared > 0 ? declared / 100 : 0,
      receipt: false,
      own_hand: false,
      non_commercial: true,
      // A tag e a ponte externalRef <-> painel SuperFrete (prova da idempotencia).
      tags: [{ tag: input.externalRef }],
    },
    platform: "RM Cards",
  };
}

// ---------------------------------------------------------------------------
// createLabel — cart + checkout, idempotente por externalRef
// ---------------------------------------------------------------------------

type RawCart = { id?: string; price?: number | string; status?: string };

async function createCart(
  input: CreateLabelInput,
): Promise<{ superFreteId: string; priceCents: number | null }> {
  // Efeito colateral: SEM retry HTTP (idempotencia e por externalRef, camada acima).
  const { data, meta } = await superFreteRequest<RawCart>("/api/v0/cart", {
    method: "POST",
    body: JSON.stringify(buildCartPayload(input)),
  });
  const id = typeof data?.id === "string" && data.id !== "" ? data.id : null;
  if (!id) {
    throw new SuperFreteLabelError(
      "provider",
      "SuperFrete nao devolveu o id do envio (cart).",
      undefined,
      meta.requestId,
    );
  }
  return { superFreteId: id, priceCents: priceToCents(data?.price) };
}

/**
 * Checagem de saldo/franquia ANTES do checkout (caso 5 do contrato): falha rapido e
 * o cart pendente NAO fica orfao (esta no store, retomavel). A checagem em si e
 * best-effort: se ELA falhar (rede/HTTP), prossegue e deixa o provedor decidir.
 */
async function ensureWalletAllows(priceCents: number | null): Promise<void> {
  let wallet: WalletBalance;
  try {
    wallet = await getWalletBalance();
  } catch {
    return;
  }
  // CONFIRMADO NO PORTAO: limits.shipments_available NAO paga etiqueta (com saldo 0
  // e "franquia" 5, o /checkout devolveu 409 "Sem saldo na carteira!") — o contador
  // de limits e outra coisa. So SALDO autoriza o checkout.
  const enough = priceCents !== null ? wallet.balanceCents >= priceCents : wallet.balanceCents > 0;
  if (enough) return;
  throw new SuperFreteLabelError(
    "insufficient_balance",
    "Saldo SuperFrete insuficiente para emitir a etiqueta (recarregue a carteira).",
  );
}

/**
 * Compoe o CreatedLabel pos-checkout. O shape de sucesso do checkout e hipotese de
 * gate: se o body trouxer status/tracking/price usa-os; o que faltar vem do
 * order/info (capturado). Se ate o info falhar, degrada para "released" (checkout
 * 2xx/409 = pago) com preco desconhecido (0).
 */
async function composeCreated(
  superFreteId: string,
  checkoutBody: unknown,
  cartPriceCents: number | null,
  reused: boolean,
): Promise<CreatedLabel> {
  const body = (checkoutBody ?? null) as {
    status?: unknown;
    tracking?: unknown;
    price?: unknown;
  } | null;
  let status = knownStatus(body?.status);
  let trackingCode =
    typeof body?.tracking === "string" && body.tracking !== "" ? body.tracking : null;
  let priceCents = cartPriceCents ?? priceToCents(body?.price as string | number | undefined);

  if (status === null || priceCents === null) {
    try {
      const info = await getLabelInfo(superFreteId);
      status = status ?? info.status;
      trackingCode = trackingCode ?? info.trackingCode;
      priceCents = priceCents ?? info.priceCents;
    } catch {
      // best-effort: segue com os defaults abaixo
    }
  }
  return {
    superFreteId,
    trackingCode,
    status: status ?? "released",
    priceCents: priceCents ?? 0,
    reused,
  };
}

export type CreateLabelDeps = { store?: LabelStore };

/**
 * Trava de CONCORRENCIA em processo: chamadas simultaneas com o MESMO externalRef
 * compartilham UMA promessa (checagem sincrona antes de qualquer await — atomica no
 * event loop), fechando a janela check-then-act do store (double-click/webhook em
 * paralelo nao paga duas vezes). Entre INSTANCIAS (serverless), a garantia vem do
 * store persistido injetado (deps.store) — documente a coluna unica por pedido.
 */
const inflightByRef = new Map<string, Promise<CreatedLabel>>();

/**
 * Cria e paga a etiqueta (cart + checkout), IDEMPOTENTE por externalRef:
 *  - ja paga no store => devolve a mesma etiqueta (reused: true, via order/info);
 *  - cart pendente no store (falha parcial anterior) => PULA o cart e retoma o checkout;
 *  - checkout 409 "ja pago" => sucesso idempotente (409 "sem saldo" =>
 *    insufficient_balance; 409 ambiguo => verificado por leitura no order/info);
 *  - entrada do store apontando p/ etiqueta CANCELADA => referencia liberada
 *    (re-execucao emite um envio NOVO, nao "reusa" um cancelado);
 *  - chamadas CONCORRENTES com o mesmo externalRef compartilham a mesma promessa.
 * Validacao LOCAL antes de qualquer chamada (erro "validation" sem fetch).
 */
export function createLabel(
  input: CreateLabelInput,
  deps?: CreateLabelDeps,
): Promise<CreatedLabel> {
  // Funcao sincrona que devolve Promise (p/ o memo de concorrencia ser atomico);
  // NUNCA lanca sincrono — falhas viram rejeicao, como o contrato espera.
  try {
    ensureConfigured();
  } catch (err) {
    return Promise.reject(err);
  }
  const invalid = validateCreateInput(input);
  if (Object.keys(invalid).length > 0) {
    logLabel("create", { externalRef: input?.externalRef, outcome: "validation" }, false);
    return Promise.reject(
      new SuperFreteLabelError("validation", "Dados invalidos para emitir a etiqueta.", invalid),
    );
  }

  // Memo sincrono (sem await antes): concorrentes pegam a MESMA promessa.
  const inflight = inflightByRef.get(input.externalRef);
  if (inflight) return inflight;
  const run = createLabelExclusive(input, deps?.store ?? memoryStore).finally(() => {
    inflightByRef.delete(input.externalRef);
  });
  inflightByRef.set(input.externalRef, run);
  return run;
}

async function createLabelExclusive(
  input: CreateLabelInput,
  store: LabelStore,
): Promise<CreatedLabel> {
  const externalRef = input.externalRef;

  try {
    let existing = await store.get(externalRef);

    // Entrada apontando para etiqueta CANCELADA (ex.: re-execucao apos limpeza):
    // a referencia esta liberada — ignora a entrada e emite um envio novo.
    let existingInfo: LabelInfo | null = null;
    let existingInfoError: unknown = null;
    if (existing) {
      try {
        existingInfo = await getLabelInfo(existing.superFreteId);
      } catch (err) {
        existingInfoError = err; // resume tolera; dedupe pago NAO fabrica dados
      }
      if (existingInfo?.status === "canceled") {
        existing = null;
        existingInfo = null;
      }
    }

    // Dedupe: mesma referencia ja paga => NUNCA cobra duas vezes. Sem info do
    // provedor nao ha o que devolver com verdade — propaga (leitura e retry-safe).
    if (existing?.paid) {
      if (!existingInfo) throw existingInfoError ?? new Error("order/info indisponivel");
      logLabel(
        "create",
        { superFreteId: existing.superFreteId, externalRef, outcome: "reused" },
        true,
      );
      return {
        superFreteId: existing.superFreteId,
        trackingCode: existingInfo.trackingCode,
        status: existingInfo.status,
        priceCents: existingInfo.priceCents ?? 0,
        reused: true,
      };
    }

    // Retomada (caso 4): cart ja criado antes => pula direto pro checkout.
    let superFreteId: string;
    let cartPriceCents: number | null = null;
    if (existing) {
      superFreteId = existing.superFreteId;
      cartPriceCents = existingInfo?.priceCents ?? null;
    } else {
      const cart = await createCart(input);
      superFreteId = cart.superFreteId;
      cartPriceCents = cart.priceCents;
      await store.set(externalRef, { superFreteId, paid: false });
    }

    await ensureWalletAllows(cartPriceCents);

    // Checkout SEM retry HTTP (paga/emite). 409 e um CONFLICT generico —
    // CONFIRMADO NO PORTAO que "sem saldo" tambem vem como 409 ("Sem saldo na
    // carteira!"), entao NUNCA trate 409 como pago as cegas: classifica pela
    // mensagem e, no ambiguo, VERIFICA POR LEITURA (order/info e a fonte da
    // verdade sobre pago/nao-pago).
    let checkoutBody: unknown = null;
    let alreadyPaid = false;
    let requestId = "";
    try {
      const res = await superFreteRequest<unknown>("/api/v0/checkout", {
        method: "POST",
        body: JSON.stringify({ orders: [superFreteId] }),
      });
      checkoutBody = res.data;
      requestId = res.meta.requestId;
    } catch (err) {
      if (err instanceof SuperFreteError && err.status === 409) {
        const conflictText = [
          err.message,
          ...Object.values(providerFieldErrors(err.body) ?? {}).flat(),
        ].join(" | ");
        if (isBalanceMessage(conflictText)) throw err; // vira insufficient_balance no mapeamento
        if (/pag[oa]|paid/i.test(conflictText)) {
          alreadyPaid = true; // 409 "ja pago" explicito
          requestId = err.requestId;
        } else {
          // Ambiguo: le o estado real. Pago => sucesso idempotente; senao propaga.
          const verified = await getLabelInfo(superFreteId);
          if (!PAID_STATUSES.includes(verified.status)) throw err;
          alreadyPaid = true;
          requestId = err.requestId;
        }
      } else {
        throw err;
      }
    }
    await store.set(externalRef, { superFreteId, paid: true });

    const reused = alreadyPaid || existing != null;
    const created = await composeCreated(
      superFreteId,
      alreadyPaid ? null : checkoutBody,
      cartPriceCents,
      reused,
    );
    logLabel(
      "create",
      { requestId, superFreteId, externalRef, outcome: reused ? "reused" : "ok" },
      true,
    );
    return created;
  } catch (err) {
    const mapped = toLabelError(err, "create");
    logLabel("create", { requestId: mapped.requestId, externalRef, outcome: mapped.code }, false);
    throw mapped;
  }
}

// ---------------------------------------------------------------------------
// printLabel — POST /api/v0/tag/print
// ---------------------------------------------------------------------------

/** Garante `format=` na URL do artefato (append/replace) — o body com format e hipotese de gate. */
function withFormatParam(url: string, format: PrintFormat): string {
  try {
    const u = new URL(url);
    u.searchParams.set("format", format);
    return u.toString();
  } catch {
    // URL fora do padrao WHATWG: reescreve/anexa o query param na unha.
    if (/([?&])format=[^&]*/.test(url)) {
      return url.replace(/([?&])format=[^&]*/, `$1format=${format}`);
    }
    return `${url}${url.includes("?") ? "&" : "?"}format=${format}`;
  }
}

/** URL de impressao da etiqueta no formato pedido (A4 padrao; A6 = termica). */
export async function printLabel(
  superFreteId: string,
  format: PrintFormat = "A4",
): Promise<PrintedLabel> {
  ensureConfigured();
  try {
    const { data, meta } = await superFreteRequest<{ url?: unknown }>("/api/v0/tag/print", {
      method: "POST",
      body: JSON.stringify({ orders: [superFreteId], format }),
    });
    const rawUrl = typeof data?.url === "string" && data.url !== "" ? data.url : null;
    if (!rawUrl) {
      throw new SuperFreteLabelError(
        "provider",
        "SuperFrete nao devolveu a URL de impressao.",
        undefined,
        meta.requestId,
      );
    }
    logLabel("print", { requestId: meta.requestId, superFreteId, outcome: "ok" }, true);
    return { url: withFormatParam(rawUrl, format), format };
  } catch (err) {
    const mapped = toLabelError(err, "print");
    logLabel("print", { requestId: mapped.requestId, superFreteId, outcome: mapped.code }, false);
    throw mapped;
  }
}

// ---------------------------------------------------------------------------
// cancelLabel — POST /api/v0/order/cancel
// ---------------------------------------------------------------------------

/** Status que ja passaram pelo pagamento — cancelar nesses gera estorno p/ carteira. */
const PAID_STATUSES: readonly LabelStatus[] = ["released", "posted", "delivered"];

/**
 * Cancela a etiqueta. Consulta order/info ANTES (best-effort):
 *  - ja "canceled" => CURTO-CIRCUITO no-op (caso 9): {canceled:true, refunded:false}
 *    sem novo POST (re-cancelar nao gera estorno novo — nada de credito fantasma);
 *  - paga (released/posted/delivered) => refunded true;
 *  - pendente ou consulta falhou => refunded false (best-effort).
 */
export async function cancelLabel(superFreteId: string, reason?: string): Promise<CanceledLabel> {
  ensureConfigured();
  let refunded = false;
  try {
    const info = await getLabelInfo(superFreteId);
    if (info.status === "canceled") {
      logLabel("cancel", { superFreteId, outcome: "already_canceled" }, true);
      return { canceled: true, refunded: false };
    }
    refunded = PAID_STATUSES.includes(info.status);
  } catch {
    refunded = false; // consulta falhou: assume sem estorno
  }
  try {
    const { data, meta } = await superFreteRequest<
      Record<string, { canceled?: boolean } | undefined>
    >("/api/v0/order/cancel", {
      method: "POST",
      body: JSON.stringify({
        order: { id: superFreteId, description: reason ?? "Cancelado pela loja" },
      }),
    });
    // Tolerante: 200 sem a chave do id = aceito; so nega se vier canceled: false.
    const entry = data?.[superFreteId];
    const canceled = entry ? entry.canceled === true : true;
    logLabel(
      "cancel",
      { requestId: meta.requestId, superFreteId, outcome: canceled ? "ok" : "not_canceled" },
      true,
    );
    return { canceled, refunded };
  } catch (err) {
    // Fallback do caso 9 (o curto-circuito acima e o caminho principal): erro cujo
    // texto indique "ja cancelado" — palavras podem vir separadas ("ja foi
    // cancelada", "ja se encontra cancelado"), entao testa as duas SEM adjacencia,
    // inclusive no mapa `errors` do body.
    const cancelText =
      err instanceof SuperFreteError
        ? [err.message, ...Object.values(providerFieldErrors(err.body) ?? {}).flat()].join(" | ")
        : "";
    if (
      err instanceof SuperFreteError &&
      /j[aá]|already/i.test(cancelText) &&
      /cancel/i.test(cancelText)
    ) {
      logLabel(
        "cancel",
        { requestId: err.requestId, superFreteId, outcome: "already_canceled" },
        true,
      );
      return { canceled: true, refunded };
    }
    const mapped = toLabelError(err, "cancel");
    logLabel("cancel", { requestId: mapped.requestId, superFreteId, outcome: mapped.code }, false);
    throw mapped;
  }
}

// ---------------------------------------------------------------------------
// getWalletBalance — GET /api/v0/user (idempotente: retry ok)
// ---------------------------------------------------------------------------

type RawUser = {
  balance?: number | string;
  limits?: { shipments?: number; shipments_available?: number };
};

/** Saldo da carteira em centavos Int + franquia de envios (null quando ausente). */
export async function getWalletBalance(): Promise<WalletBalance> {
  ensureConfigured();
  try {
    const { data } = await superFreteRequest<RawUser>("/api/v0/user", { retry: true });
    return {
      balanceCents: balanceToCents(data?.balance),
      shipmentsUsed: intOrNull(data?.limits?.shipments),
      shipmentsAvailable: intOrNull(data?.limits?.shipments_available),
    };
  } catch (err) {
    throw toLabelError(err, "wallet");
  }
}

// ---------------------------------------------------------------------------
// getLabelInfo — GET /api/v0/order/info/{id} (idempotente: retry ok)
// ---------------------------------------------------------------------------

type RawInfoAddress = { postal_code?: string; name?: string; document?: string };

type RawOrderInfo = {
  id?: string;
  status?: string;
  tracking?: string;
  price?: number | string;
  /** STRING no provedor (ex.: "30") — prova do valor declarado no envio. */
  insurance_value?: number | string;
  service_id?: number | string;
  print?: { url?: string };
  to?: RawInfoAddress;
  from?: RawInfoAddress;
  height?: number | string;
  width?: number | string;
  length?: number | string;
  /** kg float do provedor. */
  weight?: number | string;
};

function mapOrderInfo(superFreteId: string, raw: RawOrderInfo): LabelInfo {
  return {
    superFreteId: typeof raw.id === "string" && raw.id !== "" ? raw.id : superFreteId,
    status: mapProviderStatus(raw.status),
    // tracking fica "" ate a postagem => null no contrato.
    trackingCode: typeof raw.tracking === "string" && raw.tracking !== "" ? raw.tracking : null,
    priceCents: priceToCents(raw.price),
    declaredValueCents: priceToCents(raw.insurance_value),
    serviceCode: intOrNull(raw.service_id) ?? 0,
    printUrl: typeof raw.print?.url === "string" && raw.print.url !== "" ? raw.print.url : null,
    toPostalCode: onlyDigits(raw.to?.postal_code ?? ""),
    toName: raw.to?.name ?? "",
    toDocument: onlyDigits(raw.to?.document ?? ""),
    fromPostalCode: onlyDigits(raw.from?.postal_code ?? ""),
    pkg: {
      // kg float -> gramas Int (multiplicacao unica + round, sem acumulo de FP).
      weightGrams: Math.round(positiveNumber(raw.weight) * 1000),
      heightCm: positiveNumber(raw.height),
      widthCm: positiveNumber(raw.width),
      lengthCm: positiveNumber(raw.length),
    },
  };
}

/** Consulta o envio no provedor e mapeia para o contrato (LabelInfo). */
export async function getLabelInfo(superFreteId: string): Promise<LabelInfo> {
  ensureConfigured();
  try {
    const { data } = await superFreteRequest<RawOrderInfo>(
      `/api/v0/order/info/${encodeURIComponent(superFreteId)}`,
      { retry: true },
    );
    return mapOrderInfo(superFreteId, data ?? {});
  } catch (err) {
    throw toLabelError(err, "info");
  }
}

// ---------------------------------------------------------------------------
// Agregado (interface congelada)
// ---------------------------------------------------------------------------

/** Implementacao da interface congelada LabelModule (consumida pelo harness do Agente B). */
export const superFreteLabels: LabelModule = {
  createLabel,
  printLabel,
  cancelLabel,
  getWalletBalance,
  getLabelInfo,
};

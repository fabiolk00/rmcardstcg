import { getSuperFreteConfig } from "./config";

/**
 * Cliente HTTP de baixo nivel do SuperFrete (REST via fetch — mesmo molde do client
 * do Asaas, lib/services/asaas/client). Auth por `Authorization: Bearer <token>`; a
 * API exige tambem um `User-Agent` identificando a aplicacao. Em erro (status >= 400)
 * lanca SuperFreteError.
 *
 * Resiliencia: a cotacao (/calculator) e READ-ONLY/idempotente — ao contrario da
 * cobranca do Asaas, re-tentar nao gera efeito colateral. Por isso o fetch re-tenta
 * timeout/rede/5xx/429 com backoff exponencial + jitter (respeitando Retry-After),
 * MAS so quando o chamador opta por `retry: true` (a cotacao opta; um POST com efeito
 * colateral nunca deveria). 401/400 nunca re-tentam (erro de credencial/payload).
 *
 * Observabilidade: cada chamada emite UMA linha estruturada [superfrete] com
 * requestId, latencia, status e tentativas. O token NUNCA chega ao logger — logCall so
 * recebe campos nao-sensiveis (nao ha "mascaramento": nada sensivel passa por la).
 */
export class SuperFreteError extends Error {
  readonly status: number;
  /** id da requisicao (correlaciona log <-> registro normalizado). */
  readonly requestId: string;
  /**
   * Body PARSEADO da resposta de erro (ex.: mapa `errors` por campo do /cart).
   * Consumido pelo modulo de etiqueta para classificar o erro (validation /
   * unavailable / saldo). NUNCA vai para log (logCall nao recebe body).
   */
  readonly body: unknown;

  constructor(message: string, status: number, requestId = "", body: unknown = null) {
    super(message);
    this.name = "SuperFreteError";
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

// Cotacao nao pode pendurar o checkout: aborta se o SuperFrete nao responder a tempo.
const SUPERFRETE_TIMEOUT_MS = 12_000;
// Resiliencia a instabilidade (429/5xx/rede). Ate MAX_RETRIES re-tentativas (3 no
// total), SO quando `retry: true` — ver doc acima.
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backoff exponencial com jitter; respeita Retry-After quando presente. O header
 * (RFC 9110) pode vir como delta-seconds ("120") ou HTTP-date ("Wed, 21 Oct ... GMT");
 * trata ambos e faz clamp em MAX_BACKOFF_MS. Forma invalida cai no backoff proprio.
 */
function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.min(Math.max(0, dateMs - Date.now()), MAX_BACKOFF_MS);
  }
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * BASE_BACKOFF_MS);
}

/** id de correlacao curto, sem depender de libs (crypto e global no runtime Node/Edge). */
function newRequestId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `sf_${Date.now().toString(36)}`;
  }
}

export type SuperFreteFetchInit = RequestInit & {
  /**
   * Re-tenta timeout/rede/5xx/429 com backoff. SO para chamadas idempotentes
   * (a cotacao /calculator e read-only). Default: false.
   */
  retry?: boolean;
};

/** Metadados de observabilidade de UMA chamada (anexados ao registro normalizado). */
export type SuperFreteCallMeta = {
  requestId: string;
  status: number;
  latencyMs: number;
  attempts: number;
};

/** Resultado bruto + metadados da chamada (o parser consome `data`, o registro `meta`). */
export type SuperFreteResponse<T> = {
  data: T;
  meta: SuperFreteCallMeta;
};

/**
 * Executa a chamada e devolve corpo + metadados. Loga UMA linha estruturada por
 * chamada (sem token). Lanca SuperFreteError em erro de status/rede (carregando o
 * requestId para correlacao).
 */
export async function superFreteRequest<T>(
  path: string,
  init?: SuperFreteFetchInit,
): Promise<SuperFreteResponse<T>> {
  const { apiUrl, token, userAgent } = getSuperFreteConfig();
  const requestId = newRequestId();
  const retry = init?.retry === true;
  const method = (init?.method ?? "GET").toUpperCase();
  const startedAt = Date.now();

  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${apiUrl}${path}`, {
        ...init,
        // signal/cache fixados DEPOIS do spread: um caller nao pode desligar o timeout
        // (12s, que protege o checkout) nem reativar o cache do Next por engano via init.
        signal: AbortSignal.timeout(SUPERFRETE_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": userAgent,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...init?.headers,
        },
        // Cotacao e por requisicao; nunca cachear no fetch do Next (cache nosso e em cache.ts).
        cache: "no-store",
      });
    } catch (err) {
      // Timeout ou falha de rede: transitorio. Re-tenta se opt-in; senao vira erro claro.
      if (retry && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
      logCall({
        requestId,
        method,
        path,
        status: isTimeout ? 504 : 502,
        latencyMs: Date.now() - startedAt,
        attempts: attempt + 1,
        outcome: isTimeout ? "timeout" : "network_error",
      });
      throw new SuperFreteError(
        isTimeout
          ? "Tempo de resposta do SuperFrete esgotado."
          : "Falha de conexao com o SuperFrete.",
        isTimeout ? 504 : 502,
        requestId,
      );
    }

    // 429/5xx sao transitorios: re-tenta (opt-in) com backoff antes de ler o corpo.
    // 401/400 (credencial/payload) NUNCA re-tentam — cairiam de novo igual.
    if (retry && !res.ok && (res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      // Drena o corpo nao consumido antes de re-tentar: devolve o socket (undici) ao
      // pool em vez de segura-lo ate o GC no caminho quente de instabilidade.
      await res.body?.cancel().catch(() => {});
      await sleep(backoffMs(attempt, res.headers.get("retry-after")));
      continue;
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        logCall({
          requestId,
          method,
          path,
          status: res.status,
          latencyMs: Date.now() - startedAt,
          attempts: attempt + 1,
          outcome: "invalid_json",
        });
        throw new SuperFreteError(
          `Resposta invalida do SuperFrete (HTTP ${res.status}).`,
          res.status,
          requestId,
        );
      }
    }

    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const msg =
        (body as { message?: string; error?: string } | null)?.message ??
        (body as { error?: string } | null)?.error ??
        `SuperFrete respondeu ${res.status}.`;
      logCall({
        requestId,
        method,
        path,
        status: res.status,
        latencyMs,
        attempts: attempt + 1,
        outcome: "http_error",
      });
      throw new SuperFreteError(msg, res.status, requestId, body);
    }

    logCall({
      requestId,
      method,
      path,
      status: res.status,
      latencyMs,
      attempts: attempt + 1,
      outcome: "ok",
    });
    return {
      data: body as T,
      meta: { requestId, status: res.status, latencyMs, attempts: attempt + 1 },
    };
  }
}

/**
 * Log estruturado de UMA chamada, no padrao do projeto (console + prefixo [tag] +
 * objeto). NUNCA inclui Authorization/token nem PII (CEP nao entra aqui). Erros vao
 * em console.error; sucesso em console.info.
 */
function logCall(fields: {
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  attempts: number;
  outcome: "ok" | "http_error" | "timeout" | "network_error" | "invalid_json";
}): void {
  const line = {
    service: "superfrete",
    requestId: fields.requestId,
    method: fields.method,
    path: fields.path,
    status: fields.status,
    latencyMs: fields.latencyMs,
    attempts: fields.attempts,
    outcome: fields.outcome,
  };
  if (fields.outcome === "ok") {
    console.info("[superfrete] call", line);
  } else {
    console.error("[superfrete] call failed", line);
  }
}

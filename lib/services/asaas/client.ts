import { getAsaasConfig } from "./config";

/**
 * Cliente HTTP de baixo nivel do Asaas.
 *
 * Autenticacao por header `access_token` (padrao do Asaas, nao Bearer). Em erro
 * (status >= 400) lanca AsaasError com a primeira mensagem do corpo de erro do
 * Asaas, que tem o formato { errors: [{ code, description }] }.
 */
export class AsaasError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "AsaasError";
    this.status = status;
    this.code = code;
  }
}

type AsaasErrorBody = {
  errors?: { code?: string; description?: string }[];
};

// Pagamento nao pode pendurar o checkout: aborta se o Asaas nao responder a tempo.
const ASAAS_TIMEOUT_MS = 15_000;
// Resiliencia a instabilidade do Asaas (429/5xx/rede). Ate MAX_RETRIES re-tentativas
// (3 tentativas no total), SO para metodos idempotentes — ver `retryable` abaixo.
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff exponencial com jitter; respeita Retry-After (segundos) quando presente. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 10_000);
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * BASE_BACKOFF_MS);
}

export async function asaasFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiUrl, apiKey } = getAsaasConfig();
  const method = (init?.method ?? "GET").toUpperCase();
  // So re-tenta metodos idempotentes (GET: getPayment, getPixQrCode). POST
  // (createCustomer/createPixCharge) NUNCA e re-tentado automaticamente, para nao
  // duplicar cliente/cobranca no Asaas — o checkout ja e idempotente por checkoutKey.
  const retryable = method === "GET";

  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${apiUrl}${path}`, {
        signal: AbortSignal.timeout(ASAAS_TIMEOUT_MS),
        ...init,
        headers: {
          "Content-Type": "application/json",
          access_token: apiKey,
          // O Asaas recomenda identificar a aplicacao nas chamadas.
          "User-Agent": "RMCards/1.0",
          ...init?.headers,
        },
        // Pagamento nunca deve ser cacheado pelo fetch do Next.
        cache: "no-store",
      });
    } catch (err) {
      // Timeout ou falha de rede: transitorio. Re-tenta se idempotente; senao vira
      // AsaasError para o checkout degradar com mensagem amigavel.
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new AsaasError("Tempo de resposta do Asaas esgotado.", 504);
      }
      throw new AsaasError("Falha de conexao com o Asaas.", 502);
    }

    // 429/5xx sao transitorios: re-tenta (idempotente) com backoff antes de ler o corpo.
    if (
      !res.ok &&
      retryable &&
      (res.status === 429 || res.status >= 500) &&
      attempt < MAX_RETRIES
    ) {
      await sleep(backoffMs(attempt, res.headers.get("retry-after")));
      continue;
    }

    const text = await res.text();
    // Corpo pode vir vazio ou (em falha rara) nao-JSON; nao deixar estourar.
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new AsaasError(`Resposta invalida do Asaas (HTTP ${res.status}).`, res.status);
      }
    }

    if (!res.ok) {
      const err = (body ?? {}) as AsaasErrorBody;
      const first = err.errors?.[0];
      throw new AsaasError(
        first?.description ?? `Asaas respondeu ${res.status}.`,
        res.status,
        first?.code ?? null,
      );
    }

    return body as T;
  }
}

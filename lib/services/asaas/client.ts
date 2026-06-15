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

export async function asaasFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiUrl, apiKey } = getAsaasConfig();

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
    // Timeout ou falha de rede: vira AsaasError para o checkout degradar com
    // mensagem amigavel, em vez de estourar um erro cru.
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new AsaasError("Tempo de resposta do Asaas esgotado.", 504);
    }
    throw new AsaasError("Falha de conexao com o Asaas.", 502);
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

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

export async function asaasFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiUrl, apiKey } = getAsaasConfig();
  const res = await fetch(`${apiUrl}${path}`, {
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

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;

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

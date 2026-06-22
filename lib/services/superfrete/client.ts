import { getSuperFreteConfig } from "./config";

/**
 * Cliente HTTP de baixo nivel do SuperFrete (REST via fetch — mesmo estilo do client
 * do Asaas). Auth por `Authorization: Bearer <token>`; a API exige tambem um
 * `User-Agent` identificando a aplicacao. Em erro (status >= 400) lanca SuperFreteError.
 */
export class SuperFreteError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SuperFreteError";
    this.status = status;
  }
}

// Cotacao nao pode pendurar o checkout: aborta se o SuperFrete nao responder a tempo.
const SUPERFRETE_TIMEOUT_MS = 12_000;

export async function superFreteFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiUrl, token, userAgent } = getSuperFreteConfig();

  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      signal: AbortSignal.timeout(SUPERFRETE_TIMEOUT_MS),
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": userAgent,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers,
      },
      // Cotacao e por requisicao; nunca cachear no fetch do Next.
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new SuperFreteError("Tempo de resposta do SuperFrete esgotado.", 504);
    }
    throw new SuperFreteError("Falha de conexao com o SuperFrete.", 502);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new SuperFreteError(
        `Resposta invalida do SuperFrete (HTTP ${res.status}).`,
        res.status,
      );
    }
  }

  if (!res.ok) {
    const msg =
      (body as { message?: string; error?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      `SuperFrete respondeu ${res.status}.`;
    throw new SuperFreteError(msg, res.status);
  }

  return body as T;
}

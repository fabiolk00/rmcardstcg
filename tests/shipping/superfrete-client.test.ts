import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Testes adversariais do cliente HTTP de baixo nivel + quoteShipping (caixa-preta).
// Mock SO no boundary do fetch. NAO le a implementacao.
//
// Politica documentada do cliente:
//  - superFreteRequest(path, { retry?: boolean }) — retry: true re-tenta
//    timeout/rede/5xx/429 com backoff (max 3 tentativas); retry ausente/false
//    NUNCA re-tenta. 401/400 NUNCA re-tentam mesmo com retry. Erro -> SuperFreteError.
//  - quoteShipping(toCep, items) — normaliza CEP, cota com retry:true, devolve
//    SO modalidades com preco, ordenadas asc. [] quando env nao configurado,
//    CEP != 8 digitos, ou nenhum item valido.

const ITEMS = [
  {
    quantity: 1,
    pkg: { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 },
  },
];

function setEnv() {
  process.env.SUPERFRETE_TOKEN = "test_token";
  process.env.SUPERFRETE_FROM_CEP = "01310100";
  process.env.SUPERFRETE_API_URL = "https://sandbox.superfrete.com";
  process.env.SUPERFRETE_USER_AGENT = "RM Cards (test@example.com)";
  delete process.env.SUPERFRETE_CACHE_TTL_MS; // cache OFF por default
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

// Helpers para inspecionar a chamada de fetch
function lastInit(fetchMock: ReturnType<typeof vi.fn>, idx = 0) {
  return fetchMock.mock.calls[idx]?.[1] as RequestInit | undefined;
}
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const h = init?.headers;
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  // lower-case as chaves para comparacao insensivel a caixa
  return Object.fromEntries(
    Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
  );
}
function headerGet(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

const SAMPLE_QUOTE = [
  { id: 2, name: "SEDEX", company: { name: "Correios" }, price: "39.90", delivery_time: 2 },
  { id: 1, name: "PAC", company: { name: "Correios" }, price: "23.50", delivery_time: 6 },
];

describe("superFreteRequest — retry e erros (caixa-preta)", () => {
  beforeEach(setEnv);

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const { cacheClear } = await import("../../lib/services/superfrete/cache");
    cacheClear();
  });

  it("401 (ambiente trocado) -> SuperFreteError status 401 SEM retry (fetch 1x)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ message: "Unauthorized" }, 401);
      }),
    );
    const { superFreteRequest, SuperFreteError } =
      await import("../../lib/services/superfrete/client");
    let caught: unknown;
    try {
      await superFreteRequest("/api/v0/calculator", { method: "POST", body: "{}", retry: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SuperFreteError);
    expect((caught as { status: number }).status).toBe(401);
    expect(calls).toBe(1); // NUNCA re-tenta 401, mesmo com retry:true
  });

  it("400 -> SuperFreteError status 400 SEM retry (fetch 1x)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ message: "Bad Request" }, 400);
      }),
    );
    const { superFreteRequest, SuperFreteError } =
      await import("../../lib/services/superfrete/client");
    await expect(
      superFreteRequest("/api/v0/calculator", { method: "POST", body: "{}", retry: true }),
    ).rejects.toBeInstanceOf(SuperFreteError);
    expect(calls).toBe(1);
  });

  it("timeout (DOMException TimeoutError) nas 1as e 200 na 3a -> resolve re-tentando", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) throw new DOMException("The operation timed out.", "TimeoutError");
        return jsonResponse(SAMPLE_QUOTE, 200);
      }),
    );
    const { superFreteRequest } = await import("../../lib/services/superfrete/client");
    const res = await superFreteRequest<typeof SAMPLE_QUOTE>("/api/v0/calculator", {
      method: "POST",
      body: "{}",
      retry: true,
    });
    expect(calls).toBe(3);
    expect(res.meta.attempts).toBe(3);
    expect(res.data).toHaveLength(2);
  });

  it("timeout sem retry NUNCA re-tenta (fetch 1x) -> lanca", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    const { superFreteRequest } = await import("../../lib/services/superfrete/client");
    await expect(
      superFreteRequest("/api/v0/calculator", { method: "POST", body: "{}" }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it("503 (5xx) nas 1as e 200 depois -> resolve re-tentando (retry:true)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls < 3) return jsonResponse({ message: "unavailable" }, 503);
        return jsonResponse(SAMPLE_QUOTE, 200);
      }),
    );
    const { superFreteRequest } = await import("../../lib/services/superfrete/client");
    const res = await superFreteRequest<typeof SAMPLE_QUOTE>("/api/v0/calculator", {
      method: "POST",
      body: "{}",
      retry: true,
    });
    expect(calls).toBe(3);
    expect(res.meta.status).toBe(200);
  });

  it("503 SEM retry -> lanca SuperFreteError na 1a (fetch 1x)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ message: "unavailable" }, 503);
      }),
    );
    const { superFreteRequest, SuperFreteError } =
      await import("../../lib/services/superfrete/client");
    await expect(
      superFreteRequest("/api/v0/calculator", { method: "POST", body: "{}" }),
    ).rejects.toBeInstanceOf(SuperFreteError);
    expect(calls).toBe(1);
  });

  it("429 com Retry-After: 1 na 1a, 200 depois -> resolve re-tentando", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls < 2)
          return jsonResponse({ message: "rate limited" }, 429, { "Retry-After": "1" });
        return jsonResponse(SAMPLE_QUOTE, 200);
      }),
    );
    const { superFreteRequest } = await import("../../lib/services/superfrete/client");
    const start = Date.now();
    const res = await superFreteRequest<typeof SAMPLE_QUOTE>("/api/v0/calculator", {
      method: "POST",
      body: "{}",
      retry: true,
    });
    const elapsed = Date.now() - start;
    expect(calls).toBe(2);
    expect(res.meta.status).toBe(200);
    // Idealmente respeita Retry-After: 1s. Toleramos backoff proprio tambem; so exigimos
    // que tenha esperado algo > backoff base (>= ~250ms) antes da 2a tentativa.
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  it("retry esgota apos 3 tentativas em 5xx persistente -> lanca (fetch 3x)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return jsonResponse({ message: "unavailable" }, 503);
      }),
    );
    const { superFreteRequest } = await import("../../lib/services/superfrete/client");
    await expect(
      superFreteRequest("/api/v0/calculator", { method: "POST", body: "{}", retry: true }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(3); // max 3 tentativas totais
  });

  it("erro de rede (TypeError: fetch failed) com retry -> re-tenta e resolve", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls < 2) throw new TypeError("fetch failed");
        return jsonResponse(SAMPLE_QUOTE, 200);
      }),
    );
    const { superFreteRequest } = await import("../../lib/services/superfrete/client");
    const res = await superFreteRequest<typeof SAMPLE_QUOTE>("/api/v0/calculator", {
      method: "POST",
      body: "{}",
      retry: true,
    });
    expect(calls).toBe(2);
    expect(res.data).toHaveLength(2);
  });
});

describe("superFreteRequest — headers obrigatorios", () => {
  beforeEach(setEnv);
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const { cacheClear } = await import("../../lib/services/superfrete/cache");
    cacheClear();
  });

  it("envia Authorization Bearer, User-Agent nao-vazio, accept/content-type JSON", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SAMPLE_QUOTE, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { superFreteRequest } = await import("../../lib/services/superfrete/client");
    await superFreteRequest("/api/v0/calculator", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = headersOf(lastInit(fetchMock));
    const auth = headerGet(headers, "authorization");
    const ua = headerGet(headers, "user-agent");
    const accept = headerGet(headers, "accept");
    const ct = headerGet(headers, "content-type");

    expect(auth).toBe("Bearer test_token");
    expect(ua).toBeTruthy();
    expect((ua ?? "").length).toBeGreaterThan(0);
    expect((accept ?? "").toLowerCase()).toContain("application/json");
    expect((ct ?? "").toLowerCase()).toContain("application/json");
  });
});

describe("quoteShipping — normalizacao de CEP e guards (caixa-preta)", () => {
  beforeEach(setEnv);
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const { cacheClear } = await import("../../lib/services/superfrete/cache");
    cacheClear();
  });

  it("CEP com mascara '80010-000' normaliza e cota (fetch chamado)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SAMPLE_QUOTE, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { quoteShipping } = await import("../../lib/services/superfrete/quote");
    const out = await quoteShipping("80010-000", ITEMS);
    expect(fetchMock).toHaveBeenCalled();
    expect(out.map((o) => o.name)).toEqual(["PAC", "SEDEX"]); // ordenado asc
    expect(out[0].priceCents).toBe(2350);
    expect(out[1].priceCents).toBe(3990);
  });

  it("CEP curto '123' (< 8 digitos) -> [] SEM chamar fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SAMPLE_QUOTE, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { quoteShipping } = await import("../../lib/services/superfrete/quote");
    const out = await quoteShipping("123", ITEMS);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("CEP com letras/mascara que sobra != 8 digitos -> [] sem fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SAMPLE_QUOTE, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { quoteShipping } = await import("../../lib/services/superfrete/quote");
    const out = await quoteShipping("abc-12", ITEMS);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nenhum item valido (quantity 0) -> [] sem fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SAMPLE_QUOTE, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { quoteShipping } = await import("../../lib/services/superfrete/quote");
    const out = await quoteShipping("80010000", [
      { quantity: 0, pkg: { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 } },
    ]);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("env nao configurado (sem token) -> [] sem fetch", async () => {
    delete process.env.SUPERFRETE_TOKEN;
    const fetchMock = vi.fn(async () => jsonResponse(SAMPLE_QUOTE, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { quoteShipping } = await import("../../lib/services/superfrete/quote");
    const out = await quoteShipping("80010000", ITEMS);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resposta so-Correios (PAC+SEDEX) -> 2 opcoes ordenadas asc por preco", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          [
            {
              id: 2,
              name: "SEDEX",
              company: { name: "Correios" },
              price: "39.90",
              delivery_time: 2,
            },
            { id: 1, name: "PAC", company: { name: "Correios" }, price: "23.50", delivery_time: 6 },
          ],
          200,
        ),
      ),
    );
    const { quoteShipping } = await import("../../lib/services/superfrete/quote");
    const out = await quoteShipping("80010000", ITEMS);
    expect(out).toHaveLength(2);
    expect(out[0].priceCents).toBeLessThan(out[1].priceCents);
    expect(out[0].name).toBe("PAC");
  });
});

describe("buildProductsPayload — payload coerente no body (g->kg, cm)", () => {
  beforeEach(setEnv);
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const { cacheClear } = await import("../../lib/services/superfrete/cache");
    cacheClear();
  });

  it("converte g->kg e mantem cm (unidade) — pacote volumoso 30x30x30, 5kg", async () => {
    const { buildProductsPayload } = await import("../../lib/services/superfrete/quote");
    const out = buildProductsPayload([
      { quantity: 1, pkg: { weightGrams: 5000, lengthCm: 30, widthCm: 30, heightCm: 30 } },
    ]);
    expect(out).toHaveLength(1);
    const p = out[0] as Record<string, number>;
    expect(p.weight).toBe(5); // 5000 g -> 5 kg
    expect(p.length).toBe(30);
    expect(p.width).toBe(30);
    expect(p.height).toBe(30);
    // peso cubado = L*W*H/6000 deve ser computavel e > 0
    const cubadoKg = (p.length * p.width * p.height) / 6000;
    expect(cubadoKg).toBeGreaterThan(0);
    expect(cubadoKg).toBeCloseTo(4.5, 5); // 27000/6000
  });

  it("o body enviado ao fetch tem products[] com weight em kg e dims em cm coerentes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SAMPLE_QUOTE, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { quoteShipping } = await import("../../lib/services/superfrete/quote");
    await quoteShipping("80010000", [
      { quantity: 2, pkg: { weightGrams: 5000, lengthCm: 30, widthCm: 30, heightCm: 30 } },
    ]);
    expect(fetchMock).toHaveBeenCalled();
    const init = lastInit(fetchMock);
    expect(typeof init?.body).toBe("string");
    const body = JSON.parse(init!.body as string);
    expect(Array.isArray(body.products)).toBe(true);
    expect(body.products.length).toBeGreaterThanOrEqual(1);
    const prod = body.products[0];
    expect(prod.weight).toBe(5); // kg
    expect(prod.height).toBe(30);
    expect(prod.width).toBe(30);
    expect(prod.length).toBe(30);
    expect(prod.quantity).toBe(2);
    // peso cubado computavel > 0
    expect((prod.length * prod.width * prod.height) / 6000).toBeGreaterThan(0);
  });

  it("filtra quantidades nao-inteiras/<=0 do payload", async () => {
    const { buildProductsPayload } = await import("../../lib/services/superfrete/quote");
    const pkg = { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 };
    const out = buildProductsPayload([
      { quantity: 2, pkg },
      { quantity: 1.5, pkg },
      { quantity: 0, pkg },
      { quantity: -3, pkg },
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as Record<string, number>).quantity).toBe(2);
  });
});

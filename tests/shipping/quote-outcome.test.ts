import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cacheClear } from "@/lib/services/superfrete/cache";
import { quoteShipping, quoteShippingResult } from "@/lib/services/superfrete/quote";

/**
 * T1 / T13 / T15 / T20 do documento de investigacao: antes, TODA falha (409 de
 * cobertura, peso acima do limite, lista vazia, timeout, 401, token ausente) virava
 * o mesmo frete flat silencioso. quoteShippingResult separa "o provedor disse NAO"
 * (unavailable -> bloquear a venda) de "nao consegui perguntar" (unquoted -> flat +
 * alerta). Mock so no boundary do fetch.
 */
const PKG = { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 };
const ITEMS = [{ quantity: 1, pkg: PKG }];

function setEnv() {
  process.env.SUPERFRETE_TOKEN = "test_token";
  process.env.SUPERFRETE_FROM_CEP = "01310100";
  process.env.SUPERFRETE_API_URL = "https://sandbox.superfrete.com";
  process.env.SUPERFRETE_USER_AGENT = "RM Cards (test@example.com)";
  delete process.env.SUPERFRETE_CACHE_TTL_MS;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("fetch inesperado (sem resposta programada)");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const OK_QUOTE = [
  { id: 2, name: "SEDEX", company: { name: "Correios" }, price: "39.90", delivery_time: 2 },
  { id: 1, name: "PAC", company: { name: "Correios" }, price: "23.50", delivery_time: 6 },
];

beforeEach(() => {
  setEnv();
  cacheClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cacheClear();
});

describe("quoteShippingResult — classificacao", () => {
  it("cotou: devolve as opcoes ordenadas", async () => {
    mockFetch(json(OK_QUOTE));
    const res = await quoteShippingResult("80010000", ITEMS);
    expect(res.status).toBe("quoted");
    if (res.status === "quoted") expect(res.options.map((o) => o.name)).toEqual(["PAC", "SEDEX"]);
  });

  it("409 do provedor = SEM ENTREGA (nao e falha nossa) e nao re-tenta", async () => {
    const fn = mockFetch(json({ message: "CEP fora da area de cobertura" }, 409));
    const res = await quoteShippingResult("99999999", ITEMS);
    expect(res).toEqual({ status: "unavailable", reason: "CEP fora da area de cobertura" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Payload REAL capturado contra a API de producao (2026-07-20) para os CEPs
  // 69900000 (Rio Branco) e 99999999: o provedor devolve 400 — nunca 409 — quando
  // nao ha cobertura. Se isso for lido como falha do provedor, a loja vende flat
  // para um destino que nao atende E spama alerta de admin.
  it("400 com destination_postcode/no_result (CEP sem cobertura) = SEM ENTREGA, nao provider_error", async () => {
    const fn = mockFetch(
      json(
        {
          errors: {
            "correios.destination_postcode": ["(correios.destination_postcode) é inválido."],
            "ms-freight-calculator.no_result": [
              "Nenhum frete válido encontrado para esse serviço.",
            ],
          },
          message: "Ocorreu um ou mais erros.",
        },
        400,
      ),
    );
    const res = await quoteShippingResult("69900000", ITEMS);
    expect(res.status).toBe("unavailable");
    if (res.status === "unavailable") expect(res.reason).toContain("destination_postcode");
    expect(fn).toHaveBeenCalledTimes(1); // 400 nunca re-tenta
  });

  it("400 por payload NOSSO (peso invalido) continua provider_error — alerta legitimo", async () => {
    mockFetch(
      json(
        {
          errors: { "products.0.weight": ["(products.0.weight) é inválido."] },
          message: "Ocorreu um ou mais erros.",
        },
        400,
      ),
    );
    const res = await quoteShippingResult("80010000", ITEMS);
    expect(res).toMatchObject({ status: "unquoted", cause: "provider_error" });
  });

  it("todas as modalidades como item-erro (ex.: 31kg) = SEM ENTREGA, com o motivo do provedor", async () => {
    mockFetch(
      json([
        { id: 1, name: "PAC", error: "Peso acima do limite" },
        { id: 2, name: "SEDEX", error: "Peso acima do limite" },
      ]),
    );
    const res = await quoteShippingResult("80010000", [
      { quantity: 1, pkg: { ...PKG, weightGrams: 31_000 } },
    ]);
    expect(res).toEqual({ status: "unavailable", reason: "Peso acima do limite" });
  });

  it("200 com lista vazia = SEM ENTREGA (razao generica), nao flat silencioso", async () => {
    mockFetch(json([]));
    const res = await quoteShippingResult("80010000", ITEMS);
    expect(res.status).toBe("unavailable");
  });

  it("500 persistente = falha NOSSA/do provedor (unquoted provider_error), com detalhe p/ alerta", async () => {
    mockFetch(json({ message: "boom" }, 500), json({ message: "boom" }, 500));
    const res = await quoteShippingResult("80010000", ITEMS);
    expect(res.status).toBe("unquoted");
    if (res.status === "unquoted") {
      expect(res.cause).toBe("provider_error");
      expect(res.detail).toContain("HTTP 500");
    }
  });

  it("401 (token errado) = provider_error — nunca 'sem entrega'", async () => {
    mockFetch(json({ message: "Invalid token" }, 401));
    const res = await quoteShippingResult("80010000", ITEMS);
    expect(res).toMatchObject({ status: "unquoted", cause: "provider_error" });
  });

  it("timeout = provider_error (nao bloqueia a venda)", async () => {
    const t = new DOMException("timed out", "TimeoutError");
    mockFetch(t, t);
    const res = await quoteShippingResult("80010000", ITEMS);
    expect(res).toMatchObject({ status: "unquoted", cause: "provider_error" });
  });

  it("sem token = not_configured (mock-first), sem chamar a API", async () => {
    delete process.env.SUPERFRETE_TOKEN;
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(await quoteShippingResult("80010000", ITEMS)).toEqual({
      status: "unquoted",
      cause: "not_configured",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["vazio", ""],
    ["curto", "123"],
    ["nao-string", 12345678],
  ])("CEP %s = invalid_input, sem chamar a API (T1: sem TypeError)", async (_l, cep) => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(await quoteShippingResult(cep as unknown as string, ITEMS)).toEqual({
      status: "unquoted",
      cause: "invalid_input",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("itens ausentes/invalidos = invalid_input, sem chamar a API", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(await quoteShippingResult("80010000", [])).toMatchObject({ cause: "invalid_input" });
    expect(await quoteShippingResult("80010000", null as never)).toMatchObject({
      cause: "invalid_input",
    });
    expect(await quoteShippingResult("80010000", [{ quantity: 0, pkg: PKG }])).toMatchObject({
      cause: "invalid_input",
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("quoteShipping — null-safety (T1)", () => {
  it.each([null, undefined, "", "123", 42])("CEP %p devolve [] em vez de lancar", async (cep) => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    await expect(quoteShipping(cep as unknown as string, ITEMS)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("itens null devolve [] em vez de lancar", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    await expect(quoteShipping("80010000", null as never)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("orcamento de tempo da cotacao (protege o checkout)", () => {
  it("no maximo 2 tentativas (antes eram 3): o pior caso nao estoura a funcao", async () => {
    const t = new DOMException("timed out", "TimeoutError");
    const fn = mockFetch(t, t);
    await quoteShippingResult("80010000", ITEMS);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

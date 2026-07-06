import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Testes adversariais do parser de segregacao + adapter normalizado + cache
// (caixa-preta). Mock SO no boundary do fetch para os caminhos com rede.
//
// Contrato:
//  - parseQuote(raw) -> { options, unavailable }. Item indisponivel se tem `error`
//    OU nao tem preco valido (>0). Nao-array -> { options:[], unavailable:[] }.
//  - quoteShippingRecords(toCep, items) -> UMA linha por modalidade (cotaveis E
//    indisponiveis, distinguidas por `available`). [] nas mesmas condicoes de
//    quoteShipping.
//  - toQuoteRecords(fetched, quotedAt?) -> adapter PURO, registros PLANOS,
//    postAuditPriceCents SEMPRE null, uma linha por modalidade do array.

function setEnv() {
  process.env.SUPERFRETE_TOKEN = "test_token";
  process.env.SUPERFRETE_FROM_CEP = "01310100";
  process.env.SUPERFRETE_API_URL = "https://sandbox.superfrete.com";
  process.env.SUPERFRETE_USER_AGENT = "RM Cards (test@example.com)";
  delete process.env.SUPERFRETE_CACHE_TTL_MS;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

const ITEMS = [{ quantity: 1, pkg: { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 } }];

// Array misto: 1 valido (PAC), 1 com error, 1 com preco 0 (invalido).
const MIXED = [
  { id: 1, name: "PAC", company: { name: "Correios" }, price: "23.50", delivery_time: 6 },
  {
    id: 17,
    name: "Mini Envios",
    company: { name: "Correios" },
    error: "Indisponível para esta rota",
  },
  { id: 31, name: "Loggi", company: { name: "Loggi" }, price: "0", delivery_time: 1 },
];

describe("parseQuote — segregacao cotaveis vs indisponiveis (puro)", () => {
  beforeEach(setEnv);

  it("array misto: valido em options, error em unavailable (nao some, nao quebra)", async () => {
    const { parseQuote } = await import("../../lib/services/superfrete/quote");
    const { options, unavailable } = parseQuote(MIXED);

    // PAC valido -> options
    expect(options.map((o) => o.name)).toEqual(["PAC"]);
    expect(options[0]).toMatchObject({ serviceCode: 1, name: "PAC", priceCents: 2350, days: 6 });

    // Mini Envios (error) + Loggi (price 0) -> unavailable (nenhum sumiu)
    const unNames = unavailable.map((u) => u.name).sort();
    expect(unNames).toEqual(["Loggi", "Mini Envios"]);
    const mini = unavailable.find((u) => u.serviceCode === 17);
    expect(mini?.reason).toBe("Indisponível para esta rota");
  });

  it("entrada nao-array -> { options:[], unavailable:[] }", async () => {
    const { parseQuote } = await import("../../lib/services/superfrete/quote");
    expect(parseQuote(null)).toEqual({ options: [], unavailable: [] });
    expect(parseQuote({})).toEqual({ options: [], unavailable: [] });
    expect(parseQuote("nope")).toEqual({ options: [], unavailable: [] });
    expect(parseQuote(undefined)).toEqual({ options: [], unavailable: [] });
  });

  it("array vazio -> { options:[], unavailable:[] }", async () => {
    const { parseQuote } = await import("../../lib/services/superfrete/quote");
    expect(parseQuote([])).toEqual({ options: [], unavailable: [] });
  });

  it("parseShippingOptions == parseQuote(raw).options", async () => {
    const { parseQuote, parseShippingOptions } =
      await import("../../lib/services/superfrete/quote");
    expect(parseShippingOptions(MIXED)).toEqual(parseQuote(MIXED).options);
  });
});

describe("quoteShippingRecords — registro normalizado (caixa-preta)", () => {
  beforeEach(setEnv);
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const { cacheClear } = await import("../../lib/services/superfrete/cache");
    cacheClear();
  });

  it("uma linha por modalidade (cotaveis E indisponiveis), flags corretos", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(MIXED, 200)),
    );
    const { quoteShippingRecords } = await import("../../lib/services/superfrete/record");
    const records = await quoteShippingRecords("80010000", ITEMS);

    // 3 modalidades no array -> 3 registros
    expect(records).toHaveLength(3);

    const pac = records.find((r) => r.serviceCode === 1)!;
    expect(pac.available).toBe(true);
    expect(pac.quotedPriceCents).toBe(2350);
    expect(pac.unavailableReason).toBeNull();
    expect(pac.postAuditPriceCents).toBeNull(); // SEMPRE null na cotacao

    const mini = records.find((r) => r.serviceCode === 17)!;
    expect(mini.available).toBe(false);
    expect(mini.quotedPriceCents).toBeNull();
    expect(mini.unavailableReason).toBe("Indisponível para esta rota");
    expect(mini.postAuditPriceCents).toBeNull();

    const loggi = records.find((r) => r.serviceCode === 31)!;
    expect(loggi.available).toBe(false);
    expect(loggi.quotedPriceCents).toBeNull();
  });

  it("CEP invalido -> [] sem fetch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MIXED, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { quoteShippingRecords } = await import("../../lib/services/superfrete/record");
    const records = await quoteShippingRecords("123", ITEMS);
    expect(records).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("toQuoteRecords — adapter PURO normalizado", () => {
  beforeEach(setEnv);

  const fetched = {
    raw: MIXED,
    meta: { requestId: "req_abc", status: 200, latencyMs: 123, attempts: 1 },
    cacheHit: false,
    context: {
      fromCep: "01310100",
      toCep: "80010000",
      services: "1,2,17,31",
      totalWeightKg: 0.15,
      itemCount: 1,
    },
  };

  it("registros PLANOS (sem objeto aninhado), uma linha por modalidade, postAudit null", async () => {
    const { toQuoteRecords } = await import("../../lib/services/superfrete/record");
    const records = toQuoteRecords(fetched, "2026-06-28T00:00:00.000Z");

    expect(records).toHaveLength(3); // uma por modalidade do array

    for (const r of records) {
      // Todos os campos escalares: nenhum valor deve ser objeto/array (exceto null).
      for (const [, v] of Object.entries(r)) {
        if (v === null) continue;
        expect(typeof v).not.toBe("object");
        expect(Array.isArray(v)).toBe(false);
      }
      // determinismo
      expect(r.quotedAt).toBe("2026-06-28T00:00:00.000Z");
      // postAudit SEMPRE null
      expect(r.postAuditPriceCents).toBeNull();
      // contexto propagado plano
      expect(r.requestId).toBe("req_abc");
      expect(r.httpStatus).toBe(200);
      expect(r.latencyMs).toBe(123);
      expect(r.attempts).toBe(1);
      expect(r.cacheHit).toBe(false);
      expect(r.fromCep).toBe("01310100");
      expect(r.toCep).toBe("80010000");
      expect(r.totalWeightKg).toBe(0.15);
      expect(r.itemCount).toBe(1);
    }

    const pac = records.find((r) => r.serviceCode === 1)!;
    expect(pac.available).toBe(true);
    expect(pac.quotedPriceCents).toBe(2350);
    expect(pac.unavailableReason).toBeNull();

    const mini = records.find((r) => r.serviceCode === 17)!;
    expect(mini.available).toBe(false);
    expect(mini.quotedPriceCents).toBeNull();
    expect(mini.unavailableReason).toBe("Indisponível para esta rota");
  });

  it("raw nao-array -> [] (sem modalidades)", async () => {
    const { toQuoteRecords } = await import("../../lib/services/superfrete/record");
    const records = toQuoteRecords(
      { ...fetched, raw: { not: "an array" } },
      "2026-06-28T00:00:00.000Z",
    );
    expect(records).toEqual([]);
  });

  it("cacheHit do contexto reflete no registro", async () => {
    const { toQuoteRecords } = await import("../../lib/services/superfrete/record");
    const records = toQuoteRecords({ ...fetched, cacheHit: true }, "2026-06-28T00:00:00.000Z");
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.cacheHit === true)).toBe(true);
  });
});

describe("cache (bonus) — TTL ligado evita 2o fetch e marca cacheHit", () => {
  beforeEach(() => {
    setEnv();
    process.env.SUPERFRETE_CACHE_TTL_MS = "60000";
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    const { cacheClear } = await import("../../lib/services/superfrete/cache");
    cacheClear();
    delete process.env.SUPERFRETE_CACHE_TTL_MS;
  });

  it("2a chamada identica NAO chama fetch de novo e registro vem com cacheHit:true", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(MIXED, 200));
    vi.stubGlobal("fetch", fetchMock);
    const { quoteShippingRecords } = await import("../../lib/services/superfrete/record");

    const first = await quoteShippingRecords("80010000", ITEMS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.every((r) => r.cacheHit === false)).toBe(true);

    const second = await quoteShippingRecords("80010000", ITEMS);
    expect(fetchMock).toHaveBeenCalledTimes(1); // sem 2o fetch
    expect(second.length).toBe(first.length);
    expect(second.every((r) => r.cacheHit === true)).toBe(true);
  });
});

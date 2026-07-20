import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SONDA DE INVESTIGACAO (nao e fix) — executa 1:1 os casos do documento
 * "Investigacao Superfrete" contra o codigo real, para produzir PASS/FAIL com
 * evidencia. Mock so no boundary do fetch; nenhum acesso a banco.
 *
 * Nota: o documento assume uma rota REST `POST /api/shipping/calculate` +
 * Supabase RLS. O projeto usa SERVER ACTION (`quoteShippingAction`) + Prisma,
 * e a cotacao NAO e persistida — os casos 21..23 (RLS) e 24..25 (concorrencia
 * de INSERT) nao tem alvo. Aqui sondamos a camada equivalente: quoteShipping /
 * client / parse / resolveShippingCents.
 */

import { SuperFreteError, superFreteRequest } from "@/lib/services/superfrete/client";
import { cacheClear } from "@/lib/services/superfrete/cache";
import { effectivePackage } from "@/lib/services/superfrete/dimensions";
import {
  buildProductsPayload,
  parseQuote,
  quoteShipping,
  declaredValueCents,
} from "@/lib/services/superfrete/quote";
import { resolveShippingCents } from "@/lib/cart/shipping";
import { FLAT_SHIPPING_CENTS } from "@/lib/cart/totals";

const PKG = { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 };
const ITEMS = [{ quantity: 1, pkg: PKG }];

function setEnv() {
  process.env.SUPERFRETE_TOKEN = "test_token";
  process.env.SUPERFRETE_FROM_CEP = "01310100";
  process.env.SUPERFRETE_API_URL = "https://sandbox.superfrete.com";
  process.env.SUPERFRETE_USER_AGENT = "RM Cards (test@example.com)";
  delete process.env.SUPERFRETE_CACHE_TTL_MS;
}

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

const OK_QUOTE = [
  { id: 2, name: "SEDEX", company: { name: "Correios" }, price: "39.90", delivery_time: 2 },
  { id: 1, name: "PAC", company: { name: "Correios" }, price: "23.50", delivery_time: 6 },
];

function mockFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift() ?? json(OK_QUOTE);
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function bodyOf(fn: ReturnType<typeof vi.fn>, idx = 0) {
  const init = fn.mock.calls[idx]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

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

describe("2.1 CEP", () => {
  // CORRIGIDO (gap T1): a lib era null-unsafe (onlyDigits chamava .replace direto).
  // Agora CEP ausente/nao-string simplesmente nao cota. Ver tests/shipping/quote-outcome.
  it("T1 CEP null -> nao cota, [] e ZERO chamadas externas", async () => {
    const fn = mockFetch();
    expect(await quoteShipping(null as unknown as string, ITEMS)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("T2 CEP vazio -> [] sem fetch", async () => {
    const fn = mockFetch();
    expect(await quoteShipping("", ITEMS)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("T3 CEP '123' (formato invalido) -> [] sem fetch", async () => {
    const fn = mockFetch();
    expect(await quoteShipping("123", ITEMS)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("T4 CEP valido com hifen -> cota, envia so digitos e PRESERVA zero a esquerda", async () => {
    const fn = mockFetch(json(OK_QUOTE));
    const opts = await quoteShipping("01310-100", ITEMS);
    expect(opts.map((o) => o.name)).toEqual(["PAC", "SEDEX"]); // ordenado asc
    expect(bodyOf(fn).to.postal_code).toBe("01310100");
    expect(bodyOf(fn).from.postal_code).toBe("01310100");
  });
});

describe("2.2 Peso e dimensoes", () => {
  it("T5/T6 peso 0 ou negativo no PRODUTO -> cai no default da categoria (nunca vai 0/neg)", () => {
    const zero = effectivePackage({
      category: "Single Card",
      weightGrams: 0,
      lengthCm: 0,
      widthCm: 0,
      heightCm: 0,
    });
    const neg = effectivePackage({
      category: "Single Card",
      weightGrams: -5,
      lengthCm: -1,
      widthCm: -1,
      heightCm: -1,
    });
    expect(zero.weightGrams).toBeGreaterThan(0);
    expect(neg).toEqual(zero);
  });

  it("T5b peso 0 injetado DIRETO no QuoteItem -> segue no payload (sem validacao local)", () => {
    const payload = buildProductsPayload([
      { quantity: 1, pkg: { weightGrams: 0, lengthCm: 1, widthCm: 1, heightCm: 1 } },
    ]);
    expect(payload).toHaveLength(1);
    expect(payload[0].weight).toBe(0); // <- nao ha guard de peso > 0
  });

  it("T6b quantidade 0/negativa/fracionaria -> item DESCARTADO do payload", () => {
    expect(buildProductsPayload([{ quantity: 0, pkg: PKG }])).toHaveLength(0);
    expect(buildProductsPayload([{ quantity: -2, pkg: PKG }])).toHaveLength(0);
    expect(buildProductsPayload([{ quantity: 1.5, pkg: PKG }])).toHaveLength(0);
  });

  it("T7/T8 30kg e 31kg -> NENHUM filtro local; vai para o provedor identico", async () => {
    const fn = mockFetch(json(OK_QUOTE), json(OK_QUOTE));
    await quoteShipping("80010000", [
      { quantity: 1, pkg: { ...PKG, weightGrams: 30_000 } },
    ]);
    await quoteShipping("80010000", [
      { quantity: 1, pkg: { ...PKG, weightGrams: 31_000 } },
    ]);
    expect(bodyOf(fn, 0).products[0].weight).toBe(30);
    expect(bodyOf(fn, 1).products[0].weight).toBe(31); // enviado mesmo acima do limite SEDEX
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("T9 Mini Envios (17) nunca e solicitado — services fixo em '1,2,31' (PAC/SEDEX/Loggi)", async () => {
    const fn = mockFetch(json(OK_QUOTE));
    await quoteShipping("80010000", [{ quantity: 1, pkg: { ...PKG, weightGrams: 2100 } }]);
    expect(bodyOf(fn).services).toBe("1,2,31");
  });

  // NOTA: `quoteShipping` (compat) continua devolvendo [] aqui. Quem decide o que
  // fazer com isso agora e `quoteShippingResult` — que classifica como SEM ENTREGA
  // e faz a action/checkout BLOQUEAR em vez de cobrar o flat (ver quote-outcome).
  it("T8b provedor recusa a modalidade (item-erro) -> options []", async () => {
    mockFetch(
      json([
        { id: 1, name: "PAC", error: "Peso acima do limite" },
        { id: 2, name: "SEDEX", error: "Peso acima do limite" },
      ]),
    );
    const opts = await quoteShipping("80010000", [
      { quantity: 1, pkg: { ...PKG, weightGrams: 31_000 } },
    ]);
    expect(opts).toEqual([]);
    // e o resolver cobra o flat, sem sinalizar indisponibilidade:
    expect(resolveShippingCents({ merchandiseCents: 10_000, quotedCents: null })).toBe(
      FLAT_SHIPPING_CENTS,
    );
  });
});

describe("2.3 Erros da API", () => {
  it("T10 timeout -> re-tenta (3 tentativas) e lanca 504", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    const fn = mockFetch(timeout, timeout, timeout);
    await expect(superFreteRequest("/api/v0/calculator", { retry: true })).rejects.toMatchObject({
      status: 504,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("T11 401 -> NAO re-tenta; erro tipado carrega a msg do provedor", async () => {
    const fn = mockFetch(json({ message: "Invalid token" }, 401));
    await expect(quoteShipping("80010000", ITEMS)).rejects.toBeInstanceOf(SuperFreteError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Orcamento de tempo: a COTACAO usa 2 tentativas (6s cada) p/ nao estourar o
  // limite de execucao do checkout; o cliente cru segue em 3 (ver superfrete-client).
  it("T12 429 -> re-tenta com Retry-After e depois lanca 429 (2 tentativas na cotacao)", async () => {
    const fn = mockFetch(
      json({ message: "rate limited" }, 429, { "retry-after": "0" }),
      json({ message: "rate limited" }, 429, { "retry-after": "0" }),
    );
    await expect(quoteShipping("80010000", ITEMS)).rejects.toMatchObject({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("T13 409 -> NAO re-tenta e NAO e diferenciado de outros erros", async () => {
    const fn = mockFetch(json({ message: "CEP fora de cobertura" }, 409));
    await expect(quoteShipping("80010000", ITEMS)).rejects.toMatchObject({ status: 409 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("T14 500 -> re-tenta e lanca (2 tentativas na cotacao)", async () => {
    const fn = mockFetch(json({ message: "boom" }, 500), json({ message: "boom" }, 500));
    await expect(quoteShipping("80010000", ITEMS)).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("T14b 500 seguido de 200 -> a re-tentativa RECUPERA a cotacao", async () => {
    const fn = mockFetch(json({ message: "boom" }, 500), json(OK_QUOTE));
    const opts = await quoteShipping("80010000", ITEMS);
    expect(opts).toHaveLength(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("T15 200 com array vazio -> [] (sem erro): indistinguivel de 'sem cobertura'", async () => {
    mockFetch(json([]));
    expect(await quoteShipping("80010000", ITEMS)).toEqual([]);
  });

  it("T15b 200 com body nao-array -> [] (nao quebra)", async () => {
    mockFetch(json({ unexpected: true }));
    expect(await quoteShipping("80010000", ITEMS)).toEqual([]);
  });
});

describe("2.4 Conversao de preco", () => {
  it("T16 o provedor devolve REAIS (nao centavos): '23.50' -> 2350", () => {
    const { options } = parseQuote([{ id: 1, name: "PAC", price: "23.50" }]);
    expect(options[0].priceCents).toBe(2350);
  });

  it("T16b um valor 1500 e lido como R$1.500,00 (150000) — a hipotese 'cents' e FALSA", () => {
    const { options } = parseQuote([{ id: 1, name: "PAC", price: 1500 }]);
    expect(options[0].priceCents).toBe(150_000);
  });

  it("T17 string BR com milhar e string US -> ambas convertidas", () => {
    expect(parseQuote([{ id: 1, name: "a", price: "1.234,56" }]).options[0].priceCents).toBe(123_456);
    expect(parseQuote([{ id: 1, name: "a", price: "1,234.56" }]).options[0].priceCents).toBe(123_456);
    expect(parseQuote([{ id: 1, name: "a", price: "10,00" }]).options[0].priceCents).toBe(1000);
  });

  it("T17b preco invalido/zero/negativo -> segregado como INDISPONIVEL (nunca frete 0)", () => {
    const q = parseQuote([
      { id: 1, name: "a", price: "abc" },
      { id: 2, name: "b", price: 0 },
      { id: 3, name: "c", price: -5 },
      { id: 4, name: "d" },
    ]);
    expect(q.options).toEqual([]);
    expect(q.unavailable).toHaveLength(4);
  });

  it("T16c seguro: valor declarado em REAIS no payload, com piso R$24,50", () => {
    expect(declaredValueCents([{ quantity: 1, pkg: PKG, unitPriceCents: 1000 }])).toBe(2450);
    expect(declaredValueCents([{ quantity: 2, pkg: PKG, unitPriceCents: 50_000 }])).toBe(100_000);
    expect(declaredValueCents([{ quantity: 1, pkg: PKG }])).toBe(0); // sem valor => seguro off
  });
});

describe("2.7 Cache / repeticao", () => {
  it("T25 cache DESLIGADO por default -> 2 chamadas identicas = 2 fetches", async () => {
    const fn = mockFetch(json(OK_QUOTE), json(OK_QUOTE));
    await quoteShipping("80010000", ITEMS);
    await quoteShipping("80010000", ITEMS);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("T25b com TTL configurado -> a 2a chamada vem do cache (1 fetch)", async () => {
    process.env.SUPERFRETE_CACHE_TTL_MS = "60000";
    const fn = mockFetch(json(OK_QUOTE), json(OK_QUOTE));
    await quoteShipping("80010000", ITEMS);
    await quoteShipping("80010000", ITEMS);
    expect(fn).toHaveBeenCalledTimes(1);
    delete process.env.SUPERFRETE_CACHE_TTL_MS;
  });

  it("T24 3 cotacoes paralelas identicas -> mesmo preco, sem erro (nada e persistido)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(OK_QUOTE)),
    );
    const [a, b, c] = await Promise.all([
      quoteShipping("80010000", ITEMS),
      quoteShipping("80010000", ITEMS),
      quoteShipping("80010000", ITEMS),
    ]);
    expect(a[0].priceCents).toBe(b[0].priceCents);
    expect(b[0].priceCents).toBe(c[0].priceCents);
  });
});

describe("mock-first / fallback", () => {
  it("sem SUPERFRETE_TOKEN -> [] sem fetch (loja continua vendendo com frete flat)", async () => {
    delete process.env.SUPERFRETE_TOKEN;
    const fn = mockFetch();
    expect(await quoteShipping("80010000", ITEMS)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("frete gratis acima do limiar ignora a cotacao", () => {
    expect(resolveShippingCents({ merchandiseCents: 30_000, quotedCents: 9_999 })).toBe(0);
    expect(resolveShippingCents({ merchandiseCents: 10_000, quotedCents: 9_999 })).toBe(9_999);
  });
});

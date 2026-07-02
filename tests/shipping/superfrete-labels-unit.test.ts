import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateLabelInput, LabelAddress } from "@/lib/services/superfrete/label-types";

import { address } from "./fixtures/addresses";
import { pkgOf, product } from "./fixtures/products";

// Testes UNITARIOS do modulo de etiqueta (lib/services/superfrete/labels), no padrao
// do repo: fetch mockado no boundary (vi.stubGlobal), import dinamico POS-env,
// deterministico (ZERO rede — a integracao real fica no teste condicional do
// harness, executado pelo orquestrador no portao).
//
// Contrato exercitado: LABEL-CONTRACT.md (payload exato do /cart, checkout 409 =
// sucesso idempotente, retomada por externalRef, saldo/franquia antes do checkout,
// clamp do valor declarado, mapeamentos do order/info e do /user).

function setEnv() {
  process.env.SUPERFRETE_TOKEN = "test_token";
  process.env.SUPERFRETE_FROM_CEP = "01310100";
  process.env.SUPERFRETE_API_URL = "https://sandbox.superfrete.com";
  process.env.SUPERFRETE_USER_AGENT = "RM Cards (test@example.com)";
  delete process.env.SUPERFRETE_CACHE_TTL_MS;
  delete process.env.SUPERFRETE_INSURANCE_MIN_CENTS; // limites default (2450..1_000_000)
  delete process.env.SUPERFRETE_INSURANCE_MAX_CENTS;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

/**
 * Instala um fetch roteado por prefixo de path (um handler por endpoint). Rota nao
 * mockada lanca — nenhum teste pode "escapar" para um endpoint imprevisto.
 */
function installFetchRoutes(routes: Record<string, RouteHandler>) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, init });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (path.startsWith(prefix)) return handler(init);
    }
    throw new Error(`rota nao mockada no teste: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    calls,
    callsTo: (prefix: string) => calls.filter((c) => c.path.startsWith(prefix)),
    bodyOf: (prefix: string, idx = 0): unknown => {
      const call = calls.filter((c) => c.path.startsWith(prefix))[idx];
      return JSON.parse(String(call?.init?.body ?? "null"));
    },
  };
}

async function loadLabels() {
  return await import("../../lib/services/superfrete/labels");
}

/** Captura o erro do modulo e checa o code tipado. */
async function expectLabelError(promise: Promise<unknown>, code: string) {
  const { SuperFreteLabelError } = await loadLabels();
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SuperFreteLabelError);
  expect((caught as { code: string }).code).toBe(code);
  return caught as InstanceType<typeof SuperFreteLabelError>;
}

// ---- Input base a partir das FIXTURES existentes (enderecos/produtos reais) ----

const FROM_DOC = "12345678000199"; // CNPJ da loja (14 digitos)
const TO_DOC = "52998224725"; // CPF do destinatario (11 digitos)

function labelAddressOf(id: string, document: string): LabelAddress {
  const a = address(id);
  return {
    name: `Contato ${a.cidade}`,
    document,
    address: a.logradouro,
    number: a.numero,
    complement: a.complemento || undefined,
    district: a.bairro,
    city: a.cidade,
    stateAbbr: a.uf,
    postalCode: a.cep,
  };
}

function baseInput(overrides: Partial<CreateLabelInput> = {}): CreateLabelInput {
  const booster = product("BST-SV-001"); // 2790 centavos, pacote proprio 25g 1x9x13
  return {
    externalRef: "pedido-123",
    serviceCode: 1,
    from: labelAddressOf("sp-se", FROM_DOC),
    to: labelAddressOf("pr-curitiba", TO_DOC),
    items: [{ name: booster.name, quantity: 2, unitPriceCents: booster.priceCents }],
    pkg: pkgOf("BST-SV-001"),
    declaredValueCents: 2 * booster.priceCents, // 5580
    ...overrides,
  };
}

// ---- Respostas canonicas (shapes capturados no LABEL-CONTRACT.md) ----

const CART_OK = {
  id: "SF123",
  price: 18.78,
  protocol: "SF123",
  self_tracking: "",
  status: "pending",
  tags: [{ tag: "pedido-123" }],
};

// Saldo REAL cobre a etiqueta (confirmado no portao: a "franquia" de limits NAO
// paga etiqueta — com saldo 0 o checkout devolve 409 "Sem saldo na carteira!").
const USER_OK = { balance: 100, limits: { shipments: 0, shipments_available: 5 } };

const INFO_OK = {
  id: "SF123",
  status: "released",
  tracking: "",
  price: 18.78,
  insurance_value: "55.80",
  service_id: 1,
  print: { url: "https://sandbox.superfrete.com/print/SF123?format=A4" },
  to: {
    postal_code: "80010000",
    name: "Contato Curitiba",
    document: TO_DOC,
    location_number: "285",
  },
  from: { postal_code: "01001000", location_number: "100" },
  height: 1,
  width: 9,
  length: 13,
  weight: 0.025,
};

beforeEach(setEnv);

afterEach(async () => {
  vi.unstubAllGlobals();
  const { labelStoreClear } = await loadLabels();
  labelStoreClear();
  vi.resetModules();
  const { cacheClear } = await import("../../lib/services/superfrete/cache");
  cacheClear();
});

describe("createLabel — happy path (payload exato + checkout)", () => {
  it("envia o payload do contrato ao /cart e paga via /checkout {orders:[id]}", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
    });
    const { createLabel } = await loadLabels();

    const out = await createLabel(baseInput());

    // Sequencia: cart -> checagem de carteira -> checkout (sem order/info: o body trouxe status).
    expect(r.calls.map((c) => c.path)).toEqual([
      "/api/v0/cart",
      "/api/v0/user",
      "/api/v0/checkout",
    ]);

    const cart = r.bodyOf("/api/v0/cart") as Record<string, unknown>;
    expect(cart.platform).toBe("RM Cards");
    expect(cart.service).toBe(1);
    expect(cart.from).toEqual({
      name: "Contato São Paulo",
      document: FROM_DOC,
      address: "Praça da Sé",
      number: "100",
      complement: "Apto 10",
      district: "Sé",
      city: "São Paulo",
      state_abbr: "SP",
      postal_code: "01001000", // CEP normalizado (sem mascara)
    });
    expect(cart.to).toEqual({
      name: "Contato Curitiba",
      document: TO_DOC,
      address: "Rua XV de Novembro",
      number: "285",
      district: "Centro",
      city: "Curitiba",
      state_abbr: "PR",
      postal_code: "80010000",
    });
    // Declaracao de conteudo: quantity/unitary_value como STRING 2 casas (plugin).
    expect(cart.products).toEqual([
      { name: "Booster Pack Escarlate & Violeta", quantity: "2", unitary_value: "27.90" },
    ]);
    // Volume unico consolidado: g -> kg (divisao unica), cm direto.
    expect(cart.volumes).toEqual({ height: 1, width: 9, length: 13, weight: 0.025 });
    expect(cart.options).toEqual({
      insurance_value: 55.8, // 5580 centavos -> reais na borda
      receipt: false,
      own_hand: false,
      non_commercial: true, // declaracao de conteudo (sem NF)
      tags: [{ tag: "pedido-123" }],
    });

    expect(r.bodyOf("/api/v0/checkout")).toEqual({ orders: ["SF123"] });
    expect(out).toEqual({
      superFreteId: "SF123",
      trackingCode: null,
      status: "released",
      priceCents: 1878, // 18.78 reais -> centavos Int
      reused: false,
    });
  });
});

describe("createLabel — validacao LOCAL (erro sem fetch)", () => {
  async function expectValidationWithoutFetch(input: CreateLabelInput) {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createLabel } = await loadLabels();
    const err = await expectLabelError(createLabel(input), "validation");
    expect(fetchMock).not.toHaveBeenCalled();
    return err;
  }

  it("to.document ausente => validation, com o campo apontado", async () => {
    const err = await expectValidationWithoutFetch(
      baseInput({ to: labelAddressOf("pr-curitiba", "") }),
    );
    expect(Object.keys(err.fields ?? {})).toContain("to.document");
  });

  it("CEP de destino curto => validation", async () => {
    const to = { ...labelAddressOf("pr-curitiba", TO_DOC), postalCode: "1234" };
    const err = await expectValidationWithoutFetch(baseInput({ to }));
    expect(Object.keys(err.fields ?? {})).toContain("to.postal_code");
  });

  it("items vazio => validation", async () => {
    await expectValidationWithoutFetch(baseInput({ items: [] }));
  });

  it("quantidade nao-inteira => validation", async () => {
    await expectValidationWithoutFetch(
      baseInput({ items: [{ name: "Carta", quantity: 1.5, unitPriceCents: 1000 }] }),
    );
  });

  it("peso > 30 kg => validation (nao gasta chamada)", async () => {
    await expectValidationWithoutFetch(
      baseInput({ pkg: { ...pkgOf("BST-SV-001"), weightGrams: 30_001 } }),
    );
  });

  it("dimensao > 150 cm => validation", async () => {
    await expectValidationWithoutFetch(
      baseInput({ pkg: { ...pkgOf("BST-SV-001"), lengthCm: 151 } }),
    );
  });
});

describe("createLabel — clamp defensivo do valor declarado", () => {
  it("500 centavos (abaixo do piso) eleva ao minimo: insurance_value 24.5", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
    });
    const { createLabel } = await loadLabels();
    await createLabel(baseInput({ declaredValueCents: 500 }));
    const cart = r.bodyOf("/api/v0/cart") as { options: { insurance_value: number } };
    expect(cart.options.insurance_value).toBe(24.5);
  });

  it("1_500_000 centavos (acima do teto) limita ao maximo: insurance_value 10000", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
    });
    const { createLabel } = await loadLabels();
    await createLabel(baseInput({ declaredValueCents: 1_500_000 }));
    const cart = r.bodyOf("/api/v0/cart") as { options: { insurance_value: number } };
    expect(cart.options.insurance_value).toBe(10_000);
  });
});

describe("createLabel — idempotencia por externalRef", () => {
  it("2a chamada com o mesmo externalRef NAO refaz o cart e devolve reused:true", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
      "/api/v0/order/info": () => jsonResponse(INFO_OK),
    });
    const { createLabel } = await loadLabels();

    const first = await createLabel(baseInput());
    expect(first.reused).toBe(false);

    const second = await createLabel(baseInput());
    expect(second.reused).toBe(true);
    expect(second.superFreteId).toBe("SF123");
    expect(second.priceCents).toBe(1878); // via order/info (nao ha 2a cobranca)

    expect(r.callsTo("/api/v0/cart")).toHaveLength(1); // cart dedupado
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(1); // pago uma unica vez
  });

  it("retomada apos checkout falho: 2a chamada PULA o cart e refaz so o checkout", async () => {
    let checkoutCalls = 0;
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => {
        checkoutCalls += 1;
        return checkoutCalls === 1
          ? jsonResponse({ message: "internal error" }, 500)
          : jsonResponse({ status: "released" });
      },
      "/api/v0/order/info": () => jsonResponse(INFO_OK),
    });
    const { createLabel } = await loadLabels();

    await expectLabelError(createLabel(baseInput()), "provider"); // falha parcial (cart ok)

    const second = await createLabel(baseInput());
    expect(second.reused).toBe(true);
    expect(second.superFreteId).toBe("SF123");
    expect(second.priceCents).toBe(1878); // completado via order/info (cart pulado)

    expect(r.callsTo("/api/v0/cart")).toHaveLength(1); // NAO cria novo cart
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(2);
  });

  it("checkout 409 (ja pago no provedor) => sucesso idempotente reused:true", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ message: "Pedido ja pago." }, 409),
      "/api/v0/order/info": () => jsonResponse(INFO_OK),
    });
    const { createLabel } = await loadLabels();

    const out = await createLabel(baseInput());
    expect(out.reused).toBe(true);
    expect(out.superFreteId).toBe("SF123");
    expect(out.status).toBe("released"); // composto via order/info
    expect(out.priceCents).toBe(1878);
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(1); // 409 NAO re-tenta
  });
});

describe("createLabel — saldo/franquia antes do checkout", () => {
  it("balance 0 + shipments_available 0 => insufficient_balance SEM chamar checkout", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () =>
        jsonResponse({ balance: 0, limits: { shipments: 0, shipments_available: 0 } }),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
    });
    const { createLabel } = await loadLabels();

    await expectLabelError(createLabel(baseInput()), "insufficient_balance");
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(0);
    expect(r.callsTo("/api/v0/cart")).toHaveLength(1); // cart pendente fica catalogado
  });

  it("checagem de carteira falhando (HTTP 500) => prossegue best-effort ate o checkout", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse({ message: "oops" }, 500),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
    });
    const { createLabel } = await loadLabels();

    const out = await createLabel(baseInput());
    expect(out.superFreteId).toBe("SF123");
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(1); // o provedor decide
  });
});

describe("printLabel", () => {
  it("manda {orders, format} no body e ajusta o format da URL (A4 -> A6)", async () => {
    const r = installFetchRoutes({
      "/api/v0/tag/print": () =>
        jsonResponse({ url: "https://sandbox.superfrete.com/print/SF123?format=A4" }),
    });
    const { printLabel } = await loadLabels();

    const out = await printLabel("SF123", "A6");
    expect(r.bodyOf("/api/v0/tag/print")).toEqual({ orders: ["SF123"], format: "A6" });
    expect(out.format).toBe("A6");
    expect(out.url).toContain("format=A6");
    expect(out.url).not.toContain("format=A4");
  });

  it("URL sem query ganha o param; default do formato e A4", async () => {
    installFetchRoutes({
      "/api/v0/tag/print": () =>
        jsonResponse({ url: "https://sandbox.superfrete.com/print/SF123" }),
    });
    const { printLabel } = await loadLabels();

    const out = await printLabel("SF123");
    expect(out.format).toBe("A4");
    expect(out.url).toContain("format=A4");
  });

  it("resposta sem url => erro provider", async () => {
    installFetchRoutes({ "/api/v0/tag/print": () => jsonResponse({}) });
    const { printLabel } = await loadLabels();
    await expectLabelError(printLabel("SF123"), "provider");
  });
});

describe("cancelLabel", () => {
  it("etiqueta paga (status released) => canceled true + refunded true (estorno)", async () => {
    const r = installFetchRoutes({
      "/api/v0/order/info": () => jsonResponse(INFO_OK), // released = paga
      "/api/v0/order/cancel": () => jsonResponse({ SF123: { canceled: true } }),
    });
    const { cancelLabel } = await loadLabels();

    const out = await cancelLabel("SF123", "cliente desistiu");
    expect(out).toEqual({ canceled: true, refunded: true });
    expect(r.bodyOf("/api/v0/order/cancel")).toEqual({
      order: { id: "SF123", description: "cliente desistiu" },
    });
  });

  it("etiqueta pendente => canceled true + refunded false (sem estorno)", async () => {
    installFetchRoutes({
      "/api/v0/order/info": () => jsonResponse({ ...INFO_OK, status: "pending" }),
      "/api/v0/order/cancel": () => jsonResponse({ SF123: { canceled: true } }),
    });
    const { cancelLabel } = await loadLabels();

    const out = await cancelLabel("SF123");
    expect(out).toEqual({ canceled: true, refunded: false });
  });
});

describe("getLabelInfo — mapeamento do order/info", () => {
  it("tracking '' => null; insurance_value '30' (string) => 3000 centavos; kg -> g", async () => {
    installFetchRoutes({
      "/api/v0/order/info": () => jsonResponse({ ...INFO_OK, insurance_value: "30" }),
    });
    const { getLabelInfo } = await loadLabels();

    const info = await getLabelInfo("SF123");
    expect(info.superFreteId).toBe("SF123");
    expect(info.trackingCode).toBeNull();
    expect(info.declaredValueCents).toBe(3000);
    expect(info.priceCents).toBe(1878);
    expect(info.status).toBe("released");
    expect(info.serviceCode).toBe(1);
    expect(info.printUrl).toContain("format=A4");
    expect(info.toPostalCode).toBe("80010000");
    expect(info.fromPostalCode).toBe("01001000");
    expect(info.pkg).toEqual({ weightGrams: 25, heightCm: 1, widthCm: 9, lengthCm: 13 });
  });

  it("status desconhecido do provedor degrada para 'pending'", async () => {
    installFetchRoutes({
      "/api/v0/order/info": () => jsonResponse({ ...INFO_OK, status: "weird_new_state" }),
    });
    const { getLabelInfo } = await loadLabels();
    const info = await getLabelInfo("SF123");
    expect(info.status).toBe("pending");
  });
});

describe("getWalletBalance — mapeamento do /user", () => {
  it("balance em reais float -> centavos Int; limits mapeados", async () => {
    installFetchRoutes({
      "/api/v0/user": () =>
        jsonResponse({ balance: 12.34, limits: { shipments: 1, shipments_available: 4 } }),
    });
    const { getWalletBalance } = await loadLabels();
    const out = await getWalletBalance();
    expect(out).toEqual({ balanceCents: 1234, shipmentsUsed: 1, shipmentsAvailable: 4 });
  });

  it("limits ausentes (producao) => null", async () => {
    installFetchRoutes({ "/api/v0/user": () => jsonResponse({ balance: 0 }) });
    const { getWalletBalance } = await loadLabels();
    const out = await getWalletBalance();
    expect(out).toEqual({ balanceCents: 0, shipmentsUsed: null, shipmentsAvailable: null });
  });
});

describe("createLabel — CONCORRENCIA (achado critico da revisao)", () => {
  it("2 chamadas SIMULTANEAS com o mesmo externalRef => 1 cart e 1 checkout (nunca cobra 2x)", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const r = installFetchRoutes({
      // Latencia no cart abre a janela check-then-act que o memo de voo fecha.
      "/api/v0/cart": async () => {
        await sleep(30);
        return jsonResponse(CART_OK);
      },
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
    });
    const { createLabel } = await loadLabels();

    const [first, second] = await Promise.all([
      createLabel(baseInput({ externalRef: "pedido-race-1" })),
      createLabel(baseInput({ externalRef: "pedido-race-1" })),
    ]);

    expect(r.callsTo("/api/v0/cart")).toHaveLength(1);
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(1);
    expect(first.superFreteId).toBe("SF123");
    expect(second.superFreteId).toBe("SF123");
  });

  it("referencias DIFERENTES em paralelo nao se bloqueiam (2 carts, 2 checkouts)", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
    });
    const { createLabel } = await loadLabels();
    await Promise.all([
      createLabel(baseInput({ externalRef: "pedido-a" })),
      createLabel(baseInput({ externalRef: "pedido-b" })),
    ]);
    expect(r.callsTo("/api/v0/cart")).toHaveLength(2);
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(2);
  });
});

describe("createLabel — /cart NUNCA re-tenta no HTTP (pin da regra do contrato)", () => {
  it("cart 503 transitorio => exatamente 1 chamada e erro provider (sem retry que duplicaria envio)", async () => {
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse({ message: "unavailable" }, 503),
    });
    const { createLabel } = await loadLabels();
    await expectLabelError(createLabel(baseInput()), "provider");
    expect(r.callsTo("/api/v0/cart")).toHaveLength(1);
  });
});

describe("createLabel — dedupe IGNORA etiqueta cancelada (referencia liberada)", () => {
  it("entrada paga apontando p/ envio CANCELADO => emite envio NOVO (novo cart), nao 'reusa'", async () => {
    let cartCalls = 0;
    let canceledPhase = false;
    const r = installFetchRoutes({
      "/api/v0/cart": () => {
        cartCalls += 1;
        return jsonResponse({ ...CART_OK, id: cartCalls === 1 ? "SF123" : "SF124" });
      },
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ status: "released" }),
      "/api/v0/order/info": () =>
        jsonResponse(canceledPhase ? { ...INFO_OK, status: "canceled" } : INFO_OK),
    });
    const { createLabel } = await loadLabels();

    const first = await createLabel(baseInput());
    expect(first.superFreteId).toBe("SF123");

    canceledPhase = true; // a etiqueta SF123 foi cancelada (ex.: limpeza do harness)
    const second = await createLabel(baseInput());

    expect(second.superFreteId).toBe("SF124"); // envio NOVO
    expect(second.reused).toBe(false);
    expect(r.callsTo("/api/v0/cart")).toHaveLength(2);
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(2);
  });
});

describe("mapeamento de erro do provedor (body via SuperFreteError.body)", () => {
  it("400 com detalhe 'nao atendido' no mapa errors => code unavailable + fields do provedor", async () => {
    installFetchRoutes({
      "/api/v0/cart": () =>
        jsonResponse(
          {
            errors: { "to.postal_code": ["CEP de destino não atendido pela transportadora."] },
            message: "Ocorreu um ou mais erros.",
          },
          400,
        ),
    });
    const { createLabel } = await loadLabels();
    const err = await expectLabelError(createLabel(baseInput()), "unavailable");
    expect(err.fields?.["to.postal_code"]?.[0]).toContain("não atendido");
  });

  it("saldo insuficiente reportado PELO PROVEDOR no checkout => code insufficient_balance", async () => {
    installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK), // saldo cobre: pre-checagem passa
      "/api/v0/checkout": () => jsonResponse({ message: "Saldo insuficiente na carteira." }, 400),
    });
    const { createLabel } = await loadLabels();
    await expectLabelError(createLabel(baseInput()), "insufficient_balance");
  });

  it("409 'Sem saldo na carteira!' (CAPTURADO no portao) => insufficient_balance e RETOMAVEL", async () => {
    // O 409 do provedor NAO e sempre 'ja pago': o portao capturou 409 de saldo.
    let semSaldo = true;
    const r = installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () =>
        semSaldo
          ? jsonResponse(
              {
                message:
                  "Sem saldo na carteira! Utilize o app para recarregar a carteira ou pagar a etiqueta com cartão de crédito.",
                error: "Sem saldo na carteira!",
              },
              409,
            )
          : jsonResponse({ status: "released" }),
      "/api/v0/order/info": () => jsonResponse({ ...INFO_OK, status: "pending" }),
    });
    const { createLabel } = await loadLabels();

    await expectLabelError(createLabel(baseInput()), "insufficient_balance");

    // Apos recarga: retomada paga o MESMO cart (nao cria outro).
    semSaldo = false;
    const out = await createLabel(baseInput());
    expect(out.superFreteId).toBe("SF123");
    expect(r.callsTo("/api/v0/cart")).toHaveLength(1); // cart nao duplicado
    expect(r.callsTo("/api/v0/checkout")).toHaveLength(2);
  });

  it("409 AMBIGUO (sem mensagem clara) => verifica por leitura: pago no order/info = sucesso", async () => {
    installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ message: "Conflict" }, 409),
      "/api/v0/order/info": () => jsonResponse(INFO_OK), // released = pago de fato
    });
    const { createLabel } = await loadLabels();
    const out = await createLabel(baseInput());
    expect(out.reused).toBe(true);
    expect(out.status).toBe("released");
  });

  it("409 AMBIGUO com order/info ainda 'pending' => propaga erro (nunca assume pago)", async () => {
    installFetchRoutes({
      "/api/v0/cart": () => jsonResponse(CART_OK),
      "/api/v0/user": () => jsonResponse(USER_OK),
      "/api/v0/checkout": () => jsonResponse({ message: "Conflict" }, 409),
      "/api/v0/order/info": () => jsonResponse({ ...INFO_OK, status: "pending" }),
    });
    const { createLabel } = await loadLabels();
    await expectLabelError(createLabel(baseInput()), "provider"); // 409 nao-400 sem padrao => provider
  });
});

describe("cancelLabel — caso 9 do contrato (ja cancelada = no-op)", () => {
  it("status ja 'canceled' => curto-circuito {canceled:true, refunded:false} SEM POST de cancel", async () => {
    const r = installFetchRoutes({
      "/api/v0/order/info": () => jsonResponse({ ...INFO_OK, status: "canceled" }),
      "/api/v0/order/cancel": () => jsonResponse({ SF123: { canceled: true } }),
    });
    const { cancelLabel } = await loadLabels();

    const out = await cancelLabel("SF123");
    // refunded false: re-cancelar NAO gera estorno novo (sem credito fantasma).
    expect(out).toEqual({ canceled: true, refunded: false });
    expect(r.callsTo("/api/v0/order/cancel")).toHaveLength(0);
  });

  it("fallback: info falha e o POST volta 'já se encontra cancelado' => no-op tolerante", async () => {
    installFetchRoutes({
      "/api/v0/order/info": () => jsonResponse({ message: "oops" }, 500),
      "/api/v0/order/cancel": () =>
        jsonResponse({ message: "Este pedido já se encontra cancelado" }, 400),
    });
    const { cancelLabel } = await loadLabels();
    const out = await cancelLabel("SF123");
    expect(out).toEqual({ canceled: true, refunded: false });
  });
});

describe("mock-first — etiqueta NAO tem fallback flat", () => {
  it("sem SUPERFRETE_TOKEN => erro provider com mensagem clara, SEM fetch", async () => {
    delete process.env.SUPERFRETE_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { createLabel } = await loadLabels();

    const err = await expectLabelError(createLabel(baseInput()), "provider");
    expect(err.message).toContain("nao configurado");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

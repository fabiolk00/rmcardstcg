import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuoteItem } from "@/lib/services/superfrete/quote";

import {
  address,
  INVALID_FORMAT_CEPS,
  NONEXISTENT_CEP,
  STORE_FROM_CEP,
  UNSERVICED_CEP,
} from "./fixtures/addresses";
import { merchandiseCents, pkgOf, quoteItem } from "./fixtures/products";
import {
  expectedServices,
  installSuperFreteFake,
  insuranceFeeCents,
  type FakeProduct,
} from "./fixtures/superfrete-fake";

// MATRIZ DE TESTES da integracao de frete (SuperFrete /calculator), deterministica:
// o provedor e um simulador PURO instalado no boundary do fetch (fixtures/
// superfrete-fake) — a integracao real (config -> client -> quote -> parse ->
// record) roda inteira por cima, sem rede. Integracao real: apenas no grupo
// opcional tests/shipping/superfrete-sandbox.integration.test.ts (condicional a token).
//
// Linhas M1..M10 = test_matrix; asserts = success_criteria (monotonicidade por
// distancia/peso, cubagem, threshold exato de frete gratis, erros tratados,
// prazos positivos e maiores em area remota).

function setEnv() {
  process.env.SUPERFRETE_TOKEN = "test_token";
  process.env.SUPERFRETE_FROM_CEP = STORE_FROM_CEP;
  process.env.SUPERFRETE_API_URL = "https://sandbox.superfrete.com";
  process.env.SUPERFRETE_USER_AGENT = "RM Cards (test@example.com)";
  delete process.env.SUPERFRETE_CACHE_TTL_MS; // cache OFF: cada caso cota de verdade
  delete process.env.SUPERFRETE_INSURANCE_MIN_CENTS; // limites default do provedor
  delete process.env.SUPERFRETE_INSURANCE_MAX_CENTS;
}

// Limites DEFAULT de valor declarado (pinam o default da config — se o default
// mudar sem intencao, os testes de borda acusam).
const INSURANCE_MAX_CENTS_DEFAULT = 1_000_000; // R$ 10.000 (teto do provedor)

/** Modulos sob teste via import dinamico (padrao do repo: pos-stub de env/fetch). */
async function load() {
  const quote = await import("../../lib/services/superfrete/quote");
  const record = await import("../../lib/services/superfrete/record");
  const client = await import("../../lib/services/superfrete/client");
  const shipping = await import("../../lib/cart/shipping");
  const totals = await import("../../lib/cart/totals");
  return { ...quote, ...record, ...client, ...shipping, ...totals };
}

/** Payload esperado (g->kg, cm) — espelha o contrato p/ calcular o ESPERADO puro. */
function payloadOf(items: QuoteItem[]): FakeProduct[] {
  return items.map((i) => ({
    quantity: i.quantity,
    weight: i.pkg.weightGrams / 1000,
    height: i.pkg.heightCm,
    width: i.pkg.widthCm,
    length: i.pkg.lengthCm,
  }));
}

/**
 * Valor declarado esperado (centavos): soma qty x unitPriceCents, clampado ao
 * teto default — ESPELHA a regra de negocio de forma independente da implementacao.
 */
function declaredOf(items: QuoteItem[]): number {
  const raw = items.reduce(
    (s, i) => s + (i.unitPriceCents && i.unitPriceCents > 0 ? i.unitPriceCents * i.quantity : 0),
    0,
  );
  return raw <= 0 ? 0 : Math.min(raw, INSURANCE_MAX_CENTS_DEFAULT);
}

/** PAC esperado (centavos) pelo modelo puro (com seguro); lanca se o modelo nao cotar. */
function expectedPac(cep: string, items: QuoteItem[]) {
  const s = expectedServices(cep, payloadOf(items), declaredOf(items)).find(
    (x) => x.name === "PAC",
  );
  if (!s || s.priceCents == null || s.days == null) throw new Error("modelo deveria cotar PAC");
  return { priceCents: s.priceCents, days: s.days };
}

beforeEach(setEnv);

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  const { cacheClear } = await import("../../lib/services/superfrete/cache");
  cacheClear();
});

describe("M1 — carta avulsa leve para o CEP local: piso do frete", () => {
  it("cota PAC+SEDEX, PAC primeiro (mais barato), no valor-piso do modelo e prazo minimo", async () => {
    installSuperFreteFake();
    const { quoteShipping } = await load();
    const items = [quoteItem("SGL-BULK-001")]; // 50g via fallback da categoria

    const out = await quoteShipping(address("sp-se").cep, items);

    expect(out.map((o) => o.name)).toEqual(["PAC", "SEDEX"]);
    const exp = expectedPac(address("sp-se").cep, items);
    expect(out[0].priceCents).toBe(exp.priceCents);
    expect(out[0].days).toBe(exp.days);
    // Sanidade de UNIDADE: envelope local nunca custa 3 digitos de reais — se a
    // integracao mandasse GRAMAS como kg, o fake rejeitaria/estouraria este teto.
    expect(out[0].priceCents).toBeLessThan(3000);
    expect(out[0].days).toBeGreaterThan(0);
  });
});

describe("M2 — monotonicidade por distancia (mesmo item, destinos cada vez mais longe)", () => {
  it("PAC: preco e prazo nao-decrescentes ao longo da cadeia local -> Norte remoto", async () => {
    installSuperFreteFake();
    const { quoteShipping } = await load();
    const items = [quoteItem("SGL-BULK-001")];
    // Cadeia de fixtures em ordem de distancia (zona do modelo cresce junto).
    const chain = [
      "sp-se",
      "sp-holambra",
      "rj-centro",
      "pr-curitiba",
      "ba-salvador",
      "am-manaus",
      "am-humaita",
    ];

    const pacs = [];
    for (const id of chain) {
      const out = await quoteShipping(address(id).cep, items);
      const pac = out.find((o) => o.name === "PAC");
      expect(pac, `PAC deveria cotar para ${id}`).toBeTruthy();
      pacs.push({ id, priceCents: pac!.priceCents, days: pac!.days ?? 0 });
    }

    for (let i = 1; i < pacs.length; i += 1) {
      expect(pacs[i].priceCents, `${pacs[i].id} >= ${pacs[i - 1].id}`).toBeGreaterThanOrEqual(
        pacs[i - 1].priceCents,
      );
      expect(pacs[i].days, `prazo ${pacs[i].id} >= ${pacs[i - 1].id}`).toBeGreaterThanOrEqual(
        pacs[i - 1].days,
      );
      expect(pacs[i].days).toBeGreaterThan(0);
    }

    // Area remota (Humaita/AM) custa e demora ESTRITAMENTE mais que a capital (Manaus).
    const manaus = pacs.find((p) => p.id === "am-manaus")!;
    const humaita = pacs.find((p) => p.id === "am-humaita")!;
    expect(humaita.priceCents).toBeGreaterThan(manaus.priceCents);
    expect(humaita.days).toBeGreaterThan(manaus.days);
  });
});

describe("M3 — monotonicidade por peso e efeito da cubagem (mesmo destino)", () => {
  const dest = () => address("ba-salvador").cep;

  it.each([
    ["BST-SV-001 (booster 25g)", "BBX-SV-001 (booster box 550g)", "BST-SV-001", "BBX-SV-001"],
    ["SGL-BULK-001 (single 50g)", "ETB-SV-001 (ETB 950g)", "SGL-BULK-001", "ETB-SV-001"],
  ])("item mais pesado custa mais: %s < %s", async (_a, _b, lightSku, heavySku) => {
    installSuperFreteFake();
    const { quoteShipping } = await load();
    const light = await quoteShipping(dest(), [quoteItem(lightSku)]);
    const heavy = await quoteShipping(dest(), [quoteItem(heavySku)]);
    expect(heavy[0].priceCents).toBeGreaterThan(light[0].priceCents);
  });

  it("cubagem: playmat enrolado (300g reais, 427g cubados) custa mais que deck box (300g compactos)", async () => {
    installSuperFreteFake();
    const { quoteShipping } = await load();
    // MESMO peso real (300g) — so o volume difere; preco maior prova que as
    // dimensoes fluem ate o provedor e o peso cubado domina.
    const compact = await quoteShipping(dest(), [quoteItem("ACC-DBX-001")]);
    const rolled = await quoteShipping(dest(), [quoteItem("ACC-PLM-001")]);
    expect(rolled[0].priceCents).toBeGreaterThan(compact[0].priceCents);
  });
});

describe("M4 — carrinho misto: uma linha por item, quantidades e unidades preservadas", () => {
  it("payload tem 3 products (qty, kg, cm) e o preco consolida o pacote inteiro", async () => {
    const { calls } = installSuperFreteFake();
    const { quoteShipping } = await load();
    const items = [
      quoteItem("SGL-BULK-001", 3),
      quoteItem("ACC-SLV-001", 2),
      quoteItem("DCK-PRE-001", 1),
    ];

    const out = await quoteShipping(address("mg-bh").cep, items);

    expect(calls).toHaveLength(1);
    const sent = calls[0].body.products!;
    expect(sent).toHaveLength(3);
    expect(sent.map((p) => p.quantity)).toEqual([3, 2, 1]);
    expect(sent[0].weight).toBe(0.05); // 50 g -> kg (fallback da categoria Single Card)
    expect(sent[1]).toMatchObject({ weight: 0.06, height: 3, width: 7, length: 10 });
    expect(calls[0].body.from?.postal_code).toBe(STORE_FROM_CEP);

    const exp = expectedPac(address("mg-bh").cep, items);
    expect(out[0].priceCents).toBe(exp.priceCents);
    // Carrinho inteiro nunca custa menos que qualquer item sozinho.
    for (const one of items) {
      expect(out[0].priceCents).toBeGreaterThanOrEqual(
        expectedPac(address("mg-bh").cep, [one]).priceCents,
      );
    }
  });
});

describe("M5 — pedido de alto valor (carta rara R$ 2.500): seguro/valor declarado", () => {
  it("declara a mercadoria (2500.00) com seguro ligado; MESMO pacote com valor maior custa mais", async () => {
    const { calls } = installSuperFreteFake();
    const { quoteShipping } = await load();
    const rare = [quoteItem("SGL-RARE-001")]; // unitPriceCents 250000
    // Par de controle: MESMO pacote fisico, so o valor da mercadoria difere.
    const cheapSamePkg = [{ quantity: 1, pkg: pkgOf("SGL-RARE-001"), unitPriceCents: 500 }];

    const outRare = await quoteShipping(address("rj-centro").cep, rare);
    const outCheap = await quoteShipping(address("rj-centro").cep, cheapSamePkg);

    // Payload: seguro habilitado e valor declarado = MERCADORIA em reais (2500.00
    // = 250000 centavos / 100, uma divisao) — nunca o frete.
    expect(calls[0].body.options?.use_insurance_value).toBe(true);
    expect(calls[0].body.options?.insurance_value).toBe(2500);
    expect(calls[1].body.options?.use_insurance_value).toBe(true);
    expect(calls[1].body.options?.insurance_value).toBe(5);

    // O seguro reflete no custo: mesma rota+pacote, valor maior => frete maior,
    // no delta exato da taxa ad valorem do modelo.
    expect(outRare[0].priceCents).toBeGreaterThan(outCheap[0].priceCents);
    expect(outRare[0].priceCents).toBe(expectedPac(address("rj-centro").cep, rare).priceCents);
    expect(outRare[0].priceCents - outCheap[0].priceCents).toBe(
      insuranceFeeCents(250000) - insuranceFeeCents(500),
    );
  });

  it("borda: itens SEM valor unitario -> seguro desligado e sem insurance_value no payload", async () => {
    const { calls } = installSuperFreteFake();
    const { quoteShipping } = await load();
    // Sem unitPriceCents (fluxo legado): comportamento anterior preservado.
    const out = await quoteShipping(address("rj-centro").cep, [
      { quantity: 1, pkg: pkgOf("SGL-RARE-001") },
    ]);
    expect(out.length).toBeGreaterThan(0);
    expect(calls[0].body.options?.use_insurance_value).toBe(false);
    expect("insurance_value" in (calls[0].body.options ?? {})).toBe(false);
  });

  it("borda: valor ZERO -> seguro desligado (nao envia declarado invalido)", async () => {
    const { calls } = installSuperFreteFake();
    const { quoteShipping } = await load();
    const out = await quoteShipping(address("rj-centro").cep, [
      { quantity: 1, pkg: pkgOf("SGL-RARE-001"), unitPriceCents: 0 },
    ]);
    expect(out.length).toBeGreaterThan(0);
    expect(calls[0].body.options?.use_insurance_value).toBe(false);
    expect("insurance_value" in (calls[0].body.options ?? {})).toBe(false);
  });

  it("borda: acima do TETO do provedor (6x R$2.500 = R$15.000) -> clampa em R$10.000 e cota", async () => {
    const { calls } = installSuperFreteFake();
    const { quoteShipping } = await load();
    const items = [quoteItem("SGL-RARE-001", 6)]; // 1.500.000 centavos declarados
    const out = await quoteShipping(address("sp-se").cep, items);
    // Sem clamp o fake rejeitaria com 400 (> R$10.000) e out seria erro/vazio.
    expect(out.length).toBeGreaterThan(0);
    expect(calls[0].body.options?.insurance_value).toBe(INSURANCE_MAX_CENTS_DEFAULT / 100);
  });

  it("borda: PISO configurado (env) eleva o declarado ao minimo do provedor", async () => {
    process.env.SUPERFRETE_INSURANCE_MIN_CENTS = "2664"; // ex.: R$ 26,64 (piso Correios)
    const { calls } = installSuperFreteFake();
    const { quoteShipping } = await load();
    const out = await quoteShipping(address("sp-se").cep, [quoteItem("SGL-BULK-001")]); // R$ 5
    expect(out.length).toBeGreaterThan(0);
    expect(calls[0].body.options?.use_insurance_value).toBe(true);
    expect(calls[0].body.options?.insurance_value).toBe(26.64);
  });
});

describe("M6/M7 — threshold de frete gratis (R$ 299,00 de mercadoria)", () => {
  it("M6: carrinho ACIMA do threshold -> frete 0 mesmo com cotacao valida", async () => {
    installSuperFreteFake();
    const { quoteShipping, isFreeShipping, resolveShippingCents, FREE_SHIPPING_THRESHOLD_CENTS } =
      await load();
    const cart = [
      { sku: "ETB-SV-001", quantity: 1 },
      { sku: "ACC-SLV-001", quantity: 1 },
      { sku: "BST-SV-001", quantity: 1 },
    ];
    const merch = merchandiseCents(cart); // 24990+3490+2790 = 31270
    expect(merch).toBeGreaterThanOrEqual(FREE_SHIPPING_THRESHOLD_CENTS);
    expect(isFreeShipping(merch)).toBe(true);

    const out = await quoteShipping(
      address("rs-poa").cep,
      cart.map((l) => quoteItem(l.sku, l.quantity)),
    );
    expect(out[0].priceCents).toBeGreaterThan(0); // ha custo cotado...
    expect(resolveShippingCents({ merchandiseCents: merch, quotedCents: out[0].priceCents })).toBe(
      0,
    );
  });

  it("M6: dispara EXATAMENTE no threshold (>= 29900)", async () => {
    const { isFreeShipping, resolveShippingCents, FREE_SHIPPING_THRESHOLD_CENTS } = await load();
    expect(isFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS)).toBe(true);
    expect(
      resolveShippingCents({ merchandiseCents: FREE_SHIPPING_THRESHOLD_CENTS, quotedCents: 4200 }),
    ).toBe(0);
  });

  it("M7: logo abaixo do threshold (29899) -> cobra o valor COTADO", async () => {
    installSuperFreteFake();
    const { quoteShipping, isFreeShipping, resolveShippingCents, FREE_SHIPPING_THRESHOLD_CENTS } =
      await load();
    const cart = [
      { sku: "BST-SV-001", quantity: 1 },
      { sku: "ACC-SLV-001", quantity: 1 },
      { sku: "DCK-PRE-001", quantity: 1 },
    ];
    const merch = merchandiseCents(cart); // 19270 < 29900
    expect(merch).toBeLessThan(FREE_SHIPPING_THRESHOLD_CENTS);
    expect(isFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS - 1)).toBe(false);

    const out = await quoteShipping(
      address("pr-curitiba").cep,
      cart.map((l) => quoteItem(l.sku, l.quantity)),
    );
    const cobrado = resolveShippingCents({
      merchandiseCents: merch,
      quotedCents: out[0].priceCents,
    });
    expect(cobrado).toBe(out[0].priceCents);
    expect(cobrado).toBeGreaterThan(0);
  });
});

describe("M8 — CEP invalido / inexistente / nao atendido: erro tratado, nunca exception solta", () => {
  it.each([...INVALID_FORMAT_CEPS])(
    "formato invalido %j -> [] sem chamar a rede (guard antes do fetch)",
    async (cep) => {
      const { calls } = installSuperFreteFake();
      const { quoteShipping } = await load();
      const out = await quoteShipping(cep, [quoteItem("SGL-BULK-001")]);
      expect(out).toEqual([]);
      expect(calls).toHaveLength(0);
    },
  );

  it("CEP inexistente (99999-999): provedor 400 -> SuperFreteError tipado e fallback flat no caller", async () => {
    installSuperFreteFake();
    const { quoteShipping, SuperFreteError, resolveShippingCents, FLAT_SHIPPING_CENTS } =
      await load();
    const items = [quoteItem("SGL-BULK-001")];

    // O contrato da integracao: erro HTTP vira SuperFreteError TIPADO (nunca
    // exception generica), e o caller (checkout) captura e cai no frete flat.
    let caught: unknown;
    try {
      await quoteShipping(NONEXISTENT_CEP, items);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SuperFreteError);
    expect((caught as { status: number }).status).toBe(400);

    // Padrao de consumo documentado (actions.ts): catch -> cotacao null -> flat.
    const shipped = resolveShippingCents({ merchandiseCents: 10000, quotedCents: null });
    expect(shipped).toBe(FLAT_SHIPPING_CENTS);
  });

  it("CEP nao atendido (00000-000): modalidades-erro SEGREGADAS (options [] + records com razao)", async () => {
    installSuperFreteFake();
    const { quoteShipping, quoteShippingRecords } = await load();
    const items = [quoteItem("DCK-PRE-001")];

    const options = await quoteShipping(UNSERVICED_CEP, items);
    expect(options).toEqual([]); // checkout cai no flat, sem quebrar

    const records = await quoteShippingRecords(UNSERVICED_CEP, items);
    expect(records).toHaveLength(2); // PAC e SEDEX registrados, nao descartados
    for (const r of records) {
      expect(r.available).toBe(false);
      expect(r.quotedPriceCents).toBeNull();
      expect(r.unavailableReason).toMatch(/não atendido/);
    }
  });

  it("mesmo CEP com e sem hifen cota IGUAL (normalizacao)", async () => {
    const { calls } = installSuperFreteFake();
    const { quoteShipping } = await load();
    const items = [quoteItem("BST-SV-001")];

    const withHyphen = await quoteShipping("80010-000", items);
    const without = await quoteShipping("80010000", items);

    expect(withHyphen).toEqual(without);
    expect(calls.map((c) => c.body.to?.postal_code)).toEqual(["80010000", "80010000"]);
  });
});

describe("M9 — peso extremo: limite de 30 kg da modalidade", () => {
  it("40x ETB (38 kg) -> nenhuma opcao cotavel; modalidades segregadas com a razao do limite", async () => {
    installSuperFreteFake();
    const { quoteShipping, quoteShippingRecords } = await load();
    const items = [quoteItem("ETB-SV-001", 40)];

    const options = await quoteShipping(address("go-goiania").cep, items);
    expect(options).toEqual([]); // sem throw: caller cai no flat

    const records = await quoteShippingRecords(address("go-goiania").cep, items);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.available).toBe(false);
      expect(r.unavailableReason).toMatch(/limite de 30 kg/);
    }
    // O peso somado do registro reflete o extremo enviado (38 kg), sem ruido de FP.
    expect(records[0].totalWeightKg).toBe(38);
  });
});

describe("M10 — multiplas modalidades: PAC e SEDEX distintos e ordenados", () => {
  it.each([["pe-recife"], ["mt-cuiaba"], ["sc-floripa"]])(
    "destino %s: 2 opcoes asc por preco; SEDEX mais caro e mais rapido; prazos > 0",
    async (destId) => {
      installSuperFreteFake();
      const { quoteShipping } = await load();
      const out = await quoteShipping(address(destId).cep, [quoteItem("DCK-PRE-001")]);

      expect(out).toHaveLength(2);
      const [pac, sedex] = out;
      expect(pac).toMatchObject({ serviceCode: 1, name: "PAC", carrier: "Correios" });
      expect(sedex).toMatchObject({ serviceCode: 2, name: "SEDEX", carrier: "Correios" });
      expect(pac.priceCents).toBeLessThan(sedex.priceCents); // ordenado asc
      expect(pac.days).toBeGreaterThan(0);
      expect(sedex.days).toBeGreaterThan(0);
      expect(sedex.days!).toBeLessThan(pac.days!); // mais caro = mais rapido
    },
  );
});

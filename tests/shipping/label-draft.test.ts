import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildLabelDraft,
  carrierForServiceCode,
  consolidatePackage,
  type LabelDraftItem,
  type LabelDraftOrder,
} from "@/lib/shipping/labelDraft";
import { senderAddress } from "@/lib/services/superfrete/sender";
import type { LabelAddress } from "@/lib/services/superfrete/label-types";

/**
 * Emissao de etiqueta pelo admin: tudo que da para provar SEM banco e SEM rede.
 * O que estes testes protegem e o dinheiro — cada emissao debita a carteira, e
 * um dado faltando descoberto pelo provedor ja custou a chamada.
 */
const SENDER: LabelAddress = {
  name: "RM Cards",
  document: "12345678000195",
  address: "Rua da Loja",
  number: "100",
  district: "Centro",
  city: "Curitiba",
  stateAbbr: "PR",
  postalCode: "81310160",
};

const ETB = { weightGrams: 1000, lengthCm: 21, widthCm: 19, heightCm: 11 };
const BLISTER = { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 };

const ORDER: LabelDraftOrder = {
  id: 42,
  customerName: "Maria Colecionadora",
  customerEmail: "maria@exemplo.com",
  customerPhone: "(41) 99999-0000",
  customerDocument: "529.982.247-25",
  address: {
    cep: "80010-000",
    street: "Rua XV de Novembro",
    number: "285",
    complement: "Sala 3",
    district: "Centro",
    city: "Curitiba",
    state: "pr",
  },
  shippingServiceCode: 31,
};

const ITEMS: LabelDraftItem[] = [
  { name: "Elite Trainer Box", quantity: 1, unitPriceCents: 25_000, pkg: ETB },
];

describe("consolidatePackage", () => {
  it("soma peso e altura, e usa a MAIOR largura/comprimento", () => {
    expect(
      consolidatePackage([
        { name: "a", quantity: 2, unitPriceCents: 100, pkg: ETB },
        { name: "b", quantity: 1, unitPriceCents: 100, pkg: BLISTER },
      ]),
    ).toEqual({ weightGrams: 2150, heightCm: 25, widthCm: 19, lengthCm: 22 });
  });

  it("quantidade multiplica peso e altura (2 caixas empilham)", () => {
    const um = consolidatePackage([ITEMS[0]]);
    const dois = consolidatePackage([{ ...ITEMS[0], quantity: 2 }]);
    expect(dois.weightGrams).toBe(um.weightGrams * 2);
    expect(dois.heightCm).toBe(um.heightCm * 2);
    expect(dois.widthCm).toBe(um.widthCm);
  });
});

describe("carrierForServiceCode", () => {
  it.each([
    [1, "correios"],
    [2, "correios"],
    [31, "loggi"],
    [3, "jadlog"],
    [999, "outro"],
  ])("codigo %i -> %s", (code, expected) => {
    expect(carrierForServiceCode(code)).toBe(expected);
  });
});

describe("buildLabelDraft — caminho feliz", () => {
  it("monta o envio com documento/CEP so digitos, UF maiuscula e ref do pedido", () => {
    const draft = buildLabelDraft({ order: ORDER, sender: SENDER, items: ITEMS });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.input.externalRef).toBe("pedido-42");
    expect(draft.input.serviceCode).toBe(31);
    expect(draft.input.to.document).toBe("52998224725");
    expect(draft.input.to.postalCode).toBe("80010000");
    expect(draft.input.to.stateAbbr).toBe("PR");
    expect(draft.input.to.number).toBe("285");
    expect(draft.input.to.district).toBe("Centro");
    expect(draft.input.to.complement).toBe("Sala 3");
    expect(draft.input.from).toEqual(SENDER);
  });

  it("declara o MESMO valor da cotacao (soma da mercadoria, com piso do provedor)", () => {
    const draft = buildLabelDraft({ order: ORDER, sender: SENDER, items: ITEMS });
    expect(draft.ok && draft.input.declaredValueCents).toBe(25_000);

    // Item barato: sobe para o piso de R$ 24,50, igual a cotacao faz.
    const barato = buildLabelDraft({
      order: ORDER,
      sender: SENDER,
      items: [{ name: "Single", quantity: 1, unitPriceCents: 1000, pkg: BLISTER }],
    });
    expect(barato.ok && barato.input.declaredValueCents).toBe(2450);
  });

  it("a declaracao de conteudo lista os itens do pedido", () => {
    const draft = buildLabelDraft({
      order: ORDER,
      sender: SENDER,
      items: [...ITEMS, { name: "Blister", quantity: 3, unitPriceCents: 9000, pkg: BLISTER }],
    });
    expect(draft.ok && draft.input.items).toEqual([
      { name: "Elite Trainer Box", quantity: 1, unitPriceCents: 25_000 },
      { name: "Blister", quantity: 3, unitPriceCents: 9000 },
    ]);
  });
});

describe("buildLabelDraft — recusa antes de gastar dinheiro", () => {
  const cases: [string, LabelDraftOrder, string][] = [
    [
      "sem CPF/CNPJ",
      { ...ORDER, customerDocument: null },
      "customerDocument",
    ],
    [
      "CPF com digitos de menos",
      { ...ORDER, customerDocument: "1234567890" },
      "customerDocument",
    ],
    [
      "sem numero (pedido legado)",
      { ...ORDER, address: { ...ORDER.address, number: null } },
      "number",
    ],
    [
      "sem bairro (pedido legado)",
      { ...ORDER, address: { ...ORDER.address, district: null } },
      "district",
    ],
    ["CEP quebrado", { ...ORDER, address: { ...ORDER.address, cep: "8001000" } }, "cep"],
    ["sem rua", { ...ORDER, address: { ...ORDER.address, street: "  " } }, "street"],
    ["sem cidade", { ...ORDER, address: { ...ORDER.address, city: "" } }, "city"],
    ["UF invalida", { ...ORDER, address: { ...ORDER.address, state: "PRR" } }, "state"],
    ["sem modalidade cotada", { ...ORDER, shippingServiceCode: null }, "shippingServiceCode"],
  ];

  it.each(cases)("%s -> recusa com campo %s", (_label, order, field) => {
    const draft = buildLabelDraft({ order, sender: SENDER, items: ITEMS });
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.field).toBe(field);
    expect(draft.error.length).toBeGreaterThan(10); // mensagem acionavel, nao codigo
  });

  it("pedido sem itens nao vira etiqueta", () => {
    const draft = buildLabelDraft({ order: ORDER, sender: SENDER, items: [] });
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(draft.field).toBe("items");
  });

  it("produto sem peso cadastrado nao vira etiqueta (pacote de 0g)", () => {
    const draft = buildLabelDraft({
      order: ORDER,
      sender: SENDER,
      items: [
        {
          name: "X",
          quantity: 1,
          unitPriceCents: 1000,
          pkg: { weightGrams: 0, lengthCm: 10, widthCm: 10, heightCm: 10 },
        },
      ],
    });
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(draft.field).toBe("pkg");
  });
});

describe("senderAddress — remetente por ambiente", () => {
  const KEYS = [
    "SUPERFRETE_FROM_NAME",
    "SUPERFRETE_FROM_DOCUMENT",
    "SUPERFRETE_FROM_ADDRESS",
    "SUPERFRETE_FROM_NUMBER",
    "SUPERFRETE_FROM_DISTRICT",
    "SUPERFRETE_FROM_CITY",
    "SUPERFRETE_FROM_STATE",
    "SUPERFRETE_FROM_CEP",
    "SUPERFRETE_FROM_COMPLEMENT",
    "SUPERFRETE_FROM_EMAIL",
    "SUPERFRETE_FROM_PHONE",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function setAll() {
    process.env.SUPERFRETE_FROM_NAME = "RM Cards";
    process.env.SUPERFRETE_FROM_DOCUMENT = "12.345.678/0001-95";
    process.env.SUPERFRETE_FROM_ADDRESS = "Rua da Loja";
    process.env.SUPERFRETE_FROM_NUMBER = "100";
    process.env.SUPERFRETE_FROM_DISTRICT = "Centro";
    process.env.SUPERFRETE_FROM_CITY = "Curitiba";
    process.env.SUPERFRETE_FROM_STATE = "pr";
    process.env.SUPERFRETE_FROM_CEP = "81310-160";
  }

  it("sem configuracao, diz exatamente o que falta", () => {
    const res = senderAddress();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toContain("SUPERFRETE_FROM_NAME");
      expect(res.error).toContain("SUPERFRETE_FROM_DOCUMENT");
    }
  });

  it("configurado: normaliza documento, CEP e UF", () => {
    setAll();
    const res = senderAddress();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.sender.document).toBe("12345678000195");
      expect(res.sender.postalCode).toBe("81310160");
      expect(res.sender.stateAbbr).toBe("PR");
      expect(res.sender.complement).toBeUndefined();
    }
  });

  it("recusa documento e CEP malformados antes de chegar ao provedor", () => {
    setAll();
    process.env.SUPERFRETE_FROM_DOCUMENT = "123";
    expect(senderAddress().ok).toBe(false);

    setAll();
    process.env.SUPERFRETE_FROM_CEP = "8131016";
    expect(senderAddress().ok).toBe(false);

    setAll();
    process.env.SUPERFRETE_FROM_STATE = "Paraná";
    expect(senderAddress().ok).toBe(false);
  });
});

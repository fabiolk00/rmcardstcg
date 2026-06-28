import { describe, expect, it } from "vitest";

import { buildProductsPayload, parseShippingOptions } from "../../lib/services/superfrete/quote";
import { CATEGORY_PACKAGE, effectivePackage } from "../../lib/services/superfrete/dimensions";

// Parser PURO da resposta do SuperFrete /api/v0/calculator + montagem do products[].
// Sem rede: testa so a transformacao (reais->centavos, filtro de erro, ordenacao).

describe("parseShippingOptions", () => {
  it("ignora servico com erro e sem preco; reais->centavos; ordena por preco asc", () => {
    const raw = [
      { id: 2, name: "SEDEX", price: "39.90", delivery_time: 2 },
      { id: 1, name: "PAC", price: "23.50", delivery_time: 6 },
      { id: 17, name: "Mini Envios", error: "Indisponível para esta rota" },
      { id: 31, name: "Loggi", price: "0" },
    ];
    const out = parseShippingOptions(raw);
    expect(out.map((o) => o.name)).toEqual(["PAC", "SEDEX"]);
    expect(out[0]).toMatchObject({ serviceCode: 1, name: "PAC", priceCents: 2350, days: 6 });
    expect(out[1]).toMatchObject({ serviceCode: 2, name: "SEDEX", priceCents: 3990, days: 2 });
  });

  it("aceita preco numerico e virgula decimal; delivery_time 0/ausente -> days null", () => {
    const out = parseShippingOptions([
      { id: 1, name: "PAC", price: 23.5 },
      { id: 2, name: "SEDEX", price: "10,00", delivery_time: 0 },
    ]);
    const pac = out.find((o) => o.serviceCode === 1);
    const sedex = out.find((o) => o.serviceCode === 2);
    expect(pac?.priceCents).toBe(2350);
    expect(pac?.days).toBeNull();
    expect(sedex?.priceCents).toBe(1000);
    expect(sedex?.days).toBeNull();
  });

  it("preco com separador de milhar (BR '1.234,56' e US '1,234.56') nao vira NaN", () => {
    const out = parseShippingOptions([
      { id: 1, name: "BR", price: "1.234,56" },
      { id: 2, name: "US", price: "1,234.56" },
    ]);
    const br = out.find((o) => o.serviceCode === 1);
    const us = out.find((o) => o.serviceCode === 2);
    expect(br?.priceCents).toBe(123456);
    expect(us?.priceCents).toBe(123456);
  });

  it("entrada nao-array -> []", () => {
    expect(parseShippingOptions(null)).toEqual([]);
    expect(parseShippingOptions({})).toEqual([]);
  });
});

describe("buildProductsPayload", () => {
  const pkg = { weightGrams: 150, lengthCm: 22, widthCm: 19, heightCm: 3 };

  it("filtra quantidades invalidas; converte g->kg e mantem cm", () => {
    const out = buildProductsPayload([
      { quantity: 2, pkg },
      { quantity: 0, pkg },
      { quantity: -1, pkg },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ quantity: 2, weight: 0.15, height: 3, width: 19, length: 22 });
  });
});

describe("effectivePackage", () => {
  it("produto sem medida (0) -> default da categoria", () => {
    const out = effectivePackage({
      category: "Elite Trainer Box",
      weightGrams: 0,
      lengthCm: 0,
      widthCm: 0,
      heightCm: 0,
    });
    expect(out).toEqual(CATEGORY_PACKAGE["Elite Trainer Box"]);
  });

  it("usa o valor do produto quando > 0, campo a campo (resto cai no default)", () => {
    const out = effectivePackage({
      category: "Booster Box",
      weightGrams: 600,
      lengthCm: 0,
      widthCm: 0,
      heightCm: 8,
    });
    // Booster Box de 18: peso/altura do produto; comprimento/largura do default da categoria.
    expect(out.weightGrams).toBe(600);
    expect(out.heightCm).toBe(8);
    expect(out.lengthCm).toBe(CATEGORY_PACKAGE["Booster Box"].lengthCm);
    expect(out.widthCm).toBe(CATEGORY_PACKAGE["Booster Box"].widthCm);
  });
});

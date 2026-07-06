import { describe, expect, it } from "vitest";

import { HOME_CATEGORIES, collectionHref } from "@/lib/data/homeCategories";
import { CATEGORIES } from "@/lib/data/types";

// O índice editorial de categorias da home (handoff "Landing Ideias") só é fiel à
// funcionalidade se cada card cair num filtro REAL de /colecoes. Estes testes puros
// travam o contrato: categoria válida + href codificado corretamente. Se alguém
// renomear uma categoria do catálogo, o card vira filtro morto e o teste quebra
// aqui — antes de ir a produção.
describe("HOME_CATEGORIES", () => {
  it("aponta somente para categorias reais do catálogo", () => {
    for (const c of HOME_CATEGORIES) {
      expect(CATEGORIES).toContain(c.category);
    }
  });

  it("tem 4 cards com numeral editorial sequencial 01–04", () => {
    expect(HOME_CATEGORIES).toHaveLength(4);
    expect(HOME_CATEGORIES.map((c) => c.index)).toEqual(["01", "02", "03", "04"]);
  });

  it("marca exatamente os dois cards largos (01 e 04) da grade editorial", () => {
    const wide = HOME_CATEGORIES.filter((c) => c.wide).map((c) => c.index);
    expect(wide).toEqual(["01", "04"]);
  });

  it("não repete categorias entre os cards", () => {
    const cats = HOME_CATEGORIES.map((c) => c.category);
    expect(new Set(cats).size).toBe(cats.length);
  });
});

describe("collectionHref", () => {
  it("codifica a categoria na query (?cat=)", () => {
    expect(collectionHref("Booster Box")).toBe("/colecoes?cat=Booster%20Box");
    expect(collectionHref("Single Card")).toBe("/colecoes?cat=Single%20Card");
    expect(collectionHref("Acessórios")).toBe("/colecoes?cat=Acess%C3%B3rios");
  });

  it("sem categoria cai na coleção completa", () => {
    expect(collectionHref()).toBe("/colecoes");
  });
});

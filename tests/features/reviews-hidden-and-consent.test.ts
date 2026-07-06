import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Sonda de FORMA (estatica, sem banco) do refactor de 2026-07-06:
 *
 *  (A) Avaliacoes (reviews) OCULTAS do frontend por uma unica flag
 *      (NEXT_PUBLIC_REVIEWS_ENABLED), sem deletar codigo nem dados. Toda superficie
 *      de UI — pagina de produto, cards, sort, JSON-LD e admin — respeita a flag.
 *  (B) Consentimento LGPD no checkout: checkbox obrigatorio com links para as rotas
 *      legais REAIS (/termos-de-uso e /politica-de-privacidade), validado tambem no
 *      server (defense in depth).
 *  (C) Dados historicos preservados: a camada lib/data/reviews.ts e o contrato Review
 *      continuam existindo (a tabela + RLS ficam no DB, fora do alcance desta sonda).
 *  (D) Sem links quebrados: nao referenciamos as rotas inexistentes que um template
 *      generico sugeria (/privacidade, /termos, /politica-cookies, /contato).
 *
 * "Forma" e proposital: roda no CI sem Postgres e falha se um dos guards for removido.
 */

const root = process.cwd();
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

const FLAG = "REVIEWS_ENABLED";

describe("(A) reviews ocultas atras da flag REVIEWS_ENABLED", () => {
  it("a flag deriva de NEXT_PUBLIC_REVIEWS_ENABLED (default off)", () => {
    const src = read("lib/config/features.ts");
    expect(src).toMatch(/export const REVIEWS_ENABLED =/);
    expect(src).toContain("process.env.NEXT_PUBLIC_REVIEWS_ENABLED");
    // Regra fail-safe: so "true" liga.
    expect(src).toMatch(/value === "true"/);
  });

  it("pagina de produto: secao de reviews, fetch e JSON-LD atras da flag", () => {
    const src = read("app/(storefront)/produto/[slug]/page.tsx");
    expect(src).toContain(`import { ${FLAG} }`);
    // A secao de avaliacoes so renderiza com a flag on.
    expect(src).toMatch(/REVIEWS_ENABLED && reviewStats && \(\s*<ReviewsSummary/);
    // Nao dispara os SELECTs do dominio de reviews quando off.
    expect(src).toMatch(/REVIEWS_ENABLED \? getReviewStats/);
    expect(src).toMatch(/REVIEWS_ENABLED \? getApprovedReviews/);
    // aggregateRating (rich result) some junto com a UI.
    expect(src).toMatch(/REVIEWS_ENABLED && product\.reviewCount > 0/);
  });

  it("ProductInfo e ProductCard: bloco de nota (rating) atras da flag", () => {
    for (const rel of [
      "components/product/ProductInfo.tsx",
      "components/product/ProductCard.tsx",
    ]) {
      const src = read(rel);
      expect(src, `${rel} deve importar a flag`).toContain(`import { ${FLAG} }`);
      // O guard precede o container de rating (styles.rating).
      expect(src, `${rel}: rating deve estar sob REVIEWS_ENABLED`).toMatch(
        /REVIEWS_ENABLED &&[\s\S]{0,80}className=\{styles\.rating\}/,
      );
    }
  });

  it('ColecoesView: o sort "Melhor avaliados" so aparece com a flag', () => {
    const src = read("components/product/ColecoesView.tsx");
    expect(src).toContain(`import { ${FLAG} }`);
    expect(src).toMatch(
      /VISIBLE_SORTS = SORTS\.filter\(\(s\) => s\.id !== "rating" \|\| REVIEWS_ENABLED\)/,
    );
    // O dropdown renderiza a lista filtrada, nao a completa.
    expect(src).toMatch(/VISIBLE_SORTS\.map/);
    expect(src).not.toMatch(/\{SORTS\.map/);
  });

  it("admin: item de menu e rota de avaliacoes respeitam a flag", () => {
    const nav = read("components/admin/AdminNav.tsx");
    expect(nav).toContain(`import { ${FLAG} }`);
    // /admin/avaliacoes so entra em ITEMS quando a flag esta on (aparece DEPOIS do
    // ternario com REVIEWS_ENABLED).
    expect(nav).toMatch(/REVIEWS_ENABLED[\s\S]*\/admin\/avaliacoes/);

    const page = read("app/admin/avaliacoes/page.tsx");
    expect(page).toContain(`import { ${FLAG} }`);
    expect(page).toMatch(/if \(!REVIEWS_ENABLED\) notFound\(\)/);
  });
});

describe("(B) consentimento LGPD no checkout", () => {
  it("CheckoutView tem checkbox obrigatorio com links legais e trava o submit", () => {
    const src = read("components/checkout/CheckoutView.tsx");
    expect(src).toMatch(/type="checkbox"/);
    // Links para as rotas legais REAIS deste repo.
    expect(src).toContain('href="/termos-de-uso"');
    expect(src).toContain('href="/politica-de-privacidade"');
    // Trava o envio sem aceite e propaga o aceite ao server.
    expect(src).toMatch(/if \(!accepted\)/);
    expect(src).toMatch(/acceptedTerms: accepted/);
  });

  it("a server action exige acceptedTerms === true (defense in depth)", () => {
    const src = read("app/(storefront)/carrinho/actions.ts");
    expect(src).toMatch(/acceptedTerms: boolean/);
    expect(src).toMatch(/input\.acceptedTerms !== true/);
  });
});

describe("(C) dados historicos preservados (nada deletado)", () => {
  it("a camada de dados de reviews continua existindo", () => {
    expect(existsSync(path.join(root, "lib/data/reviews.ts"))).toBe(true);
    expect(existsSync(path.join(root, "lib/data/review-stats.ts"))).toBe(true);
  });

  it("o contrato de dominio Review continua em lib/data/types.ts", () => {
    const src = read("lib/data/types.ts");
    expect(src).toMatch(/export interface Review\b/);
    expect(src).toMatch(/export interface ReviewStats\b/);
  });

  it("os componentes de review NAO foram deletados (so ocultos)", () => {
    for (const rel of [
      "components/product/ReviewForm.tsx",
      "components/product/ReviewsList.tsx",
      "components/product/ReviewStats.tsx",
      "components/product/ReviewsSummary.tsx",
      "components/admin/AdminReviewsView.tsx",
    ]) {
      expect(existsSync(path.join(root, rel)), `${rel} deve existir`).toBe(true);
    }
  });
});

describe("(D) sem links quebrados: so rotas legais existentes", () => {
  it("as rotas legais linkadas existem no filesystem", () => {
    expect(existsSync(path.join(root, "app/(storefront)/politica-de-privacidade/page.tsx"))).toBe(
      true,
    );
    expect(existsSync(path.join(root, "app/(storefront)/termos-de-uso/page.tsx"))).toBe(true);
  });

  it("o rodape linka as rotas legais reais", () => {
    const src = read("components/layout/Footer.tsx");
    expect(src).toContain('href: "/politica-de-privacidade"');
    expect(src).toContain('href: "/termos-de-uso"');
  });

  it("nao ha href para rotas inexistentes (evita broken link)", () => {
    const badHrefs = [
      'href="/privacidade"',
      'href="/termos"',
      'href="/politica-cookies"',
      'href="/contato"',
      'href: "/politica-cookies"',
      'href: "/contato"',
    ];
    for (const rel of [
      "components/layout/Footer.tsx",
      "components/checkout/CheckoutView.tsx",
      "app/(storefront)/produto/[slug]/page.tsx",
    ]) {
      const src = read(rel);
      for (const bad of badHrefs) {
        expect(src.includes(bad), `${rel} nao deve conter ${bad}`).toBe(false);
      }
    }
  });
});

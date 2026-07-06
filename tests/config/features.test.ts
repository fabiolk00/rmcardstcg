import { describe, expect, it } from "vitest";

import { reviewsEnabled } from "@/lib/config/features";

// Unit da logica pura da flag de reviews. reviewsEnabled decide a visibilidade da
// feature de avaliacoes a partir da env NEXT_PUBLIC_REVIEWS_ENABLED. Regra: OCULTO
// por default — so a string exata "true" liga. Assim, um deploy sem a env mantem as
// avaliacoes escondidas (fail-safe para o objetivo de simplificacao/LGPD).
describe("features.reviewsEnabled", () => {
  it('liga SOMENTE com a string exata "true"', () => {
    expect(reviewsEnabled("true")).toBe(true);
  });

  it("fica OCULTO por default (env ausente/undefined)", () => {
    expect(reviewsEnabled(undefined)).toBe(false);
  });

  it("fica OCULTO para valores ambiguos ou desligados", () => {
    for (const v of ["", "false", "0", "1", "TRUE", "True", "yes", " true", "true "]) {
      expect(reviewsEnabled(v)).toBe(false);
    }
  });
});

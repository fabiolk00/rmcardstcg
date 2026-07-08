import { describe, expect, it } from "vitest";

import { isPaymentButtonDisabled, paymentButtonState } from "../../lib/cart/paymentButton";

// Regra: o botao de pagar so libera quando frete calculado E termos aceitos.
// Precedencia dos rotulos: submetendo > falta frete > falta aceite > pronto.

const base = { submitting: false, shippingReady: true, hasTotal: true, accepted: true };

describe("paymentButtonState", () => {
  it("frete + termos + total => ready", () => {
    expect(paymentButtonState(base)).toBe("ready");
  });

  it("submetendo tem precedencia sobre tudo", () => {
    expect(paymentButtonState({ ...base, submitting: true, shippingReady: false, accepted: false })).toBe(
      "submitting",
    );
  });

  it("sem frete calculado => needShipping", () => {
    expect(paymentButtonState({ ...base, shippingReady: false })).toBe("needShipping");
  });

  it("sem total (frete nao resolvido) => needShipping", () => {
    expect(paymentButtonState({ ...base, hasTotal: false })).toBe("needShipping");
  });

  it("frete ok mas termos nao aceitos => needTerms", () => {
    expect(paymentButtonState({ ...base, accepted: false })).toBe("needTerms");
  });

  it("falta frete tem precedencia sobre falta de aceite", () => {
    expect(paymentButtonState({ ...base, shippingReady: false, accepted: false })).toBe(
      "needShipping",
    );
  });
});

describe("isPaymentButtonDisabled", () => {
  it("so ready habilita o clique", () => {
    expect(isPaymentButtonDisabled("ready")).toBe(false);
    expect(isPaymentButtonDisabled("submitting")).toBe(true);
    expect(isPaymentButtonDisabled("needShipping")).toBe(true);
    expect(isPaymentButtonDisabled("needTerms")).toBe(true);
  });
});

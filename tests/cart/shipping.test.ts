import { describe, expect, it } from "vitest";

import { isFreeShipping, resolveShippingCents } from "../../lib/cart/shipping";
import { FLAT_SHIPPING_CENTS, FREE_SHIPPING_THRESHOLD_CENTS } from "../../lib/cart/totals";

// Regra de frete final (custo + free), pura e server-side. Free no limiar (>=29900)
// ou mercadoria 0; senao o custo cotado (SuperFrete) com fallback flat.

describe("isFreeShipping", () => {
  it("mercadoria 0 -> free", () => expect(isFreeShipping(0)).toBe(true));
  it("logo abaixo do limiar -> nao free", () =>
    expect(isFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS - 1)).toBe(false));
  it("no limiar exato -> free (>=)", () =>
    expect(isFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS)).toBe(true));
  it("acima do limiar -> free", () =>
    expect(isFreeShipping(FREE_SHIPPING_THRESHOLD_CENTS + 100)).toBe(true));
});

describe("resolveShippingCents (custo + free)", () => {
  it("free no limiar ignora a cotacao", () => {
    expect(
      resolveShippingCents({ merchandiseCents: FREE_SHIPPING_THRESHOLD_CENTS, quotedCents: 4200 }),
    ).toBe(0);
  });

  it("mercadoria 0 -> 0", () => {
    expect(resolveShippingCents({ merchandiseCents: 0, quotedCents: 4200 })).toBe(0);
  });

  it("abaixo do limiar COM cotacao -> usa o custo cotado", () => {
    expect(resolveShippingCents({ merchandiseCents: 10000, quotedCents: 4200 })).toBe(4200);
  });

  it("abaixo do limiar SEM cotacao -> flat fallback (mock-first)", () => {
    expect(resolveShippingCents({ merchandiseCents: 10000, quotedCents: null })).toBe(
      FLAT_SHIPPING_CENTS,
    );
  });
});

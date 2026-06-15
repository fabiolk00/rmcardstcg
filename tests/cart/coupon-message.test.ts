import { describe, expect, it } from "vitest";

import { couponErrorMessage } from "../../lib/cart/coupon";

// O mapeamento de mensagem de cupom não pode virar um oráculo de enumeração: os
// motivos que revelam existência/estado do código colapsam numa mensagem genérica.

describe("couponErrorMessage — não vaza existência do código", () => {
  it("colapsa not_found/inactive/not_started/expired/max_redemptions numa genérica", () => {
    const generic = couponErrorMessage("not_found");
    expect(generic).toBe("Cupom inválido ou indisponível.");
    expect(couponErrorMessage("inactive")).toBe(generic);
    expect(couponErrorMessage("not_started")).toBe(generic);
    expect(couponErrorMessage("expired")).toBe(generic);
    expect(couponErrorMessage("max_redemptions")).toBe(generic);
  });

  it("mantém mensagens específicas e acionáveis para below_min e per_user_limit", () => {
    const generic = couponErrorMessage("not_found");
    expect(couponErrorMessage("below_min")).not.toBe(generic);
    expect(couponErrorMessage("per_user_limit")).not.toBe(generic);
  });
});

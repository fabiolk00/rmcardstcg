import { describe, expect, it } from "vitest";

import { productStatusActions } from "../../lib/data/product-status";

// productStatusActions e a regra de UI da tela de produtos do admin: dado o estado
// (isActive), decide quais botoes de status a linha mostra e qual esta habilitado.
// A tela renderiza SEMPRE os dois icones lado a lado (inativar + reativar) e
// desabilita o que nao se aplica. Funcao pura -> testavel sem DOM, no espirito de
// selectCarouselProducts. Cobre a feature de REATIVAR (icone proprio ao lado do de
// inativar) e a exclusividade mutua das duas acoes.

describe("productStatusActions", () => {
  it("produto ATIVO: inativar habilitado, reativar desabilitado", () => {
    const [inactivate, reactivate] = productStatusActions(true);

    expect(inactivate.kind).toBe("inactivate");
    expect(inactivate.icon).toBe("power");
    expect(inactivate.enabled).toBe(true);
    expect(inactivate.verb).toBe("Inativar");

    expect(reactivate.kind).toBe("reactivate");
    expect(reactivate.icon).toBe("rotate");
    expect(reactivate.enabled).toBe(false);
    expect(reactivate.verb).toBe("Reativar");
  });

  it("produto INATIVO: reativar habilitado, inativar desabilitado", () => {
    const [inactivate, reactivate] = productStatusActions(false);

    expect(inactivate.kind).toBe("inactivate");
    expect(inactivate.enabled).toBe(false);

    expect(reactivate.kind).toBe("reactivate");
    expect(reactivate.enabled).toBe(true);
    // a feature pedida: o icone de reativar existe e e distinto do de inativar.
    expect(reactivate.icon).toBe("rotate");
  });

  it("ordem fixa [inativar, reativar] em ambos os estados (layout estavel)", () => {
    expect(productStatusActions(true).map((a) => a.kind)).toEqual(["inactivate", "reactivate"]);
    expect(productStatusActions(false).map((a) => a.kind)).toEqual(["inactivate", "reactivate"]);
  });

  it("exatamente uma acao habilitada para qualquer estado (mutuamente exclusivo)", () => {
    for (const isActive of [true, false]) {
      const enabled = productStatusActions(isActive).filter((a) => a.enabled);
      expect(enabled, `isActive=${isActive}`).toHaveLength(1);
    }
  });

  it("inativar e reativar usam icones distintos", () => {
    const [inactivate, reactivate] = productStatusActions(true);
    expect(inactivate.icon).not.toBe(reactivate.icon);
  });
});

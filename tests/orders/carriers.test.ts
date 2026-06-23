import { describe, expect, it } from "vitest";

import { carrierLabel, carrierTrackingUrl, isCarrierId } from "../../lib/data/carriers";

// carriers.ts é puro (sem DB): id conhecido, rótulo e URL de rastreio (encoda o
// código; null quando sem id/código/template). Cobre o "outro" (sem link).

describe("isCarrierId", () => {
  it("aceita ids conhecidos e rejeita o resto", () => {
    expect(isCarrierId("correios")).toBe(true);
    expect(isCarrierId("jadlog")).toBe(true);
    expect(isCarrierId("outro")).toBe(true);
    expect(isCarrierId("fedex")).toBe(false);
    expect(isCarrierId("")).toBe(false);
    expect(isCarrierId(null)).toBe(false);
    expect(isCarrierId(123)).toBe(false);
  });
});

describe("carrierLabel", () => {
  it("rotula ids conhecidos; eco do valor para desconhecido; — para null", () => {
    expect(carrierLabel("correios")).toBe("Correios");
    expect(carrierLabel("azul")).toBe("Azul Cargo");
    expect(carrierLabel("desconhecido")).toBe("desconhecido");
    expect(carrierLabel(null)).toBe("—");
  });
});

describe("carrierTrackingUrl", () => {
  it("monta a URL pública encodando o código", () => {
    expect(carrierTrackingUrl("correios", "AB123 456BR")).toBe(
      "https://rastreamento.correios.com.br/app/index.php?objeto=AB123%20456BR",
    );
    expect(carrierTrackingUrl("jadlog", "999")).toBe("https://www.jadlog.com.br/tracking/999");
  });

  it("null quando falta id ou código, transportador desconhecido, ou sem template (outro)", () => {
    expect(carrierTrackingUrl(null, "X")).toBeNull();
    expect(carrierTrackingUrl("correios", null)).toBeNull();
    expect(carrierTrackingUrl("correios", "")).toBeNull();
    expect(carrierTrackingUrl("fedex", "X")).toBeNull();
    expect(carrierTrackingUrl("outro", "X")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  clientKeyFromParts,
  clientRateLimitKey,
  deriveClientIp,
} from "../../lib/security/clientKey";

// Premissa provada aqui: na Vercel `x-real-ip` e o IP confiavel do cliente e NAO
// pode ser forjado (a plataforma sobrescreve o x-forwarded-for). A derivacao
// prefere x-real-ip, entao um x-forwarded-for reivindicado pelo cliente nunca
// altera a chave de rate limit — o vetor de "rotacionar XFF pra zerar o bucket"
// morre na origem.

describe("deriveClientIp — source-priority x-real-ip > x-forwarded-for", () => {
  it("prefere x-real-ip sobre um x-forwarded-for forjado", () => {
    const h = new Headers({
      "x-real-ip": "1.2.3.4",
      "x-forwarded-for": "6.6.6.6, 7.7.7.7", // leftmost reivindicado pelo cliente
    });
    expect(deriveClientIp(h)).toBe("1.2.3.4");
  });

  it("cai no leftmost do x-forwarded-for quando x-real-ip esta ausente", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(deriveClientIp(h)).toBe("1.2.3.4");
  });

  it("faz trim do IP derivado (real-ip e xff)", () => {
    expect(deriveClientIp(new Headers({ "x-real-ip": "  1.2.3.4  " }))).toBe("1.2.3.4");
    expect(deriveClientIp(new Headers({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" }))).toBe(
      "1.2.3.4",
    );
  });

  it("retorna null quando nenhum header de IP esta presente", () => {
    expect(deriveClientIp(new Headers())).toBeNull();
  });

  it("e deterministico (mesmos headers -> mesmo IP)", () => {
    const h = new Headers({ "x-real-ip": "9.9.9.9" });
    expect(deriveClientIp(h)).toBe(deriveClientIp(h));
    expect(deriveClientIp(h)).toBe("9.9.9.9");
  });
});

describe("clientKeyFromParts — contrato u:/ip:/anon (preservado)", () => {
  it("usa u:<id> para usuario autenticado e IGNORA o IP (nao forjavel via header)", () => {
    expect(clientKeyFromParts("user_123", "1.2.3.4")).toBe("u:user_123");
    expect(clientKeyFromParts("user_123", null)).toBe("u:user_123");
  });

  it("usa ip:<ip> para guest com IP derivado", () => {
    expect(clientKeyFromParts("guest", "1.2.3.4")).toBe("ip:1.2.3.4");
  });

  it("cai em anon para guest sem IP", () => {
    expect(clientKeyFromParts("guest", null)).toBe("anon");
  });

  it("e deterministico (mesmas partes -> mesma chave)", () => {
    expect(clientKeyFromParts("guest", "1.2.3.4")).toBe(clientKeyFromParts("guest", "1.2.3.4"));
  });
});

describe("clientRateLimitKey — wrapper (branches sem escopo de request)", () => {
  it("retorna u:<id> para autenticado SEM tocar em headers()", async () => {
    // userId !== "guest" => early-return antes de qualquer headers(); nao lanca
    // mesmo fora de escopo de request.
    await expect(clientRateLimitKey("user_123")).resolves.toBe("u:user_123");
  });

  it("cai em anon para guest fora de escopo de request (headers() lanca -> catch)", async () => {
    // Em teste nao ha request scope: headers() lanca e o catch devolve "anon",
    // exatamente como o comportamento original.
    await expect(clientRateLimitKey("guest")).resolves.toBe("anon");
  });
});

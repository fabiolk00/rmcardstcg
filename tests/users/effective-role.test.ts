import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { effectiveRole } from "../../lib/auth/effectiveRole";

// Decisao compartilhada de role efetiva (lib/auth/effectiveRole). Pura: usa a
// allowlist REAL via process.env.ADMIN_EMAILS (isAdminEmail) — sem DB/rede.
//
// Regra provada (foco no bug "admin virou cliente"):
//  - DB 'admin'/'cliente' => confirmado, ignora e-mail;
//  - DB null + e-mail na allowlist => admin (source 'allowlist', estado fragil);
//  - DB null + e-mail comum => cliente;
//  - DB null + e-mail AUSENTE => 'unverified' (NUNCA colapsa em 'cliente').

const ORIGINAL = process.env.ADMIN_EMAILS;

beforeEach(() => {
  process.env.ADMIN_EMAILS = "dono@loja.com, chefe@loja.com";
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ORIGINAL;
});

describe("effectiveRole", () => {
  it("DB 'admin' => admin (source db), sem olhar o e-mail", () => {
    expect(effectiveRole("admin", null)).toEqual({ role: "admin", source: "db" });
    expect(effectiveRole("admin", "qualquer@x.com")).toEqual({ role: "admin", source: "db" });
  });

  it("DB 'cliente' => cliente, mesmo com e-mail na allowlist (DB manda)", () => {
    expect(effectiveRole("cliente", "dono@loja.com")).toEqual({ role: "cliente" });
  });

  it("DB null + e-mail na allowlist => admin (source allowlist, estado fragil)", () => {
    expect(effectiveRole(null, "dono@loja.com")).toEqual({ role: "admin", source: "allowlist" });
    // case-insensitive (isAdminEmail normaliza)
    expect(effectiveRole(null, "DONO@Loja.com")).toEqual({ role: "admin", source: "allowlist" });
  });

  it("DB null + e-mail comum => cliente", () => {
    expect(effectiveRole(null, "novo@cliente.com")).toEqual({ role: "cliente" });
  });

  it("DB null + e-mail AUSENTE => unverified (nao rebaixa silenciosamente)", () => {
    expect(effectiveRole(null, null)).toEqual({ role: "unverified" });
  });

  it("DB null + ADMIN_EMAILS ausente => cliente por e-mail comum, unverified sem e-mail", () => {
    delete process.env.ADMIN_EMAILS;
    expect(effectiveRole(null, "dono@loja.com")).toEqual({ role: "cliente" });
    expect(effectiveRole(null, null)).toEqual({ role: "unverified" });
  });
});

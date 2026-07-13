import { beforeEach, describe, expect, it, vi } from "vitest";

import { storefrontRedirectTarget, type Viewer } from "../../lib/auth/resolveViewer";

// Roteador vitrine -> area logada (lib/auth/resolveViewer): papel EFETIVO do
// visitante. DB-free: boundaries (Clerk, config, users) mockados por caso.
//
// Regra provada: cliente logado => "cliente"; admin => "admin"; soft-deleted vira
// "deleted" (fica na vitrine — mandar a area logada seria loop com o guard de la);
// falha de leitura => "anon" (a vitrine nunca cai por causa do roteamento). O
// DESTINO do redirect por papel e provado a parte em storefrontRedirectTarget.

const authMock = vi.fn();
const currentUserMock = vi.fn();
const isClerkConfiguredMock = vi.fn();
const getUserRoleMock = vi.fn();
const isUserSoftDeletedMock = vi.fn();
const isAdminEmailMock = vi.fn();
const redirectMock = vi.fn();

vi.mock("next/navigation", () => ({
  // O redirect real lanca NEXT_REDIRECT para abortar o render; no teste so
  // capturamos o destino (as funcoes nao tem codigo apos o redirect).
  redirect: (url: string) => redirectMock(url),
}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  currentUser: () => currentUserMock(),
}));
vi.mock("@/lib/services/clerk/config", () => ({
  isClerkConfigured: () => isClerkConfiguredMock(),
}));
vi.mock("@/lib/services/clerk/roles", () => ({
  isAdminEmail: (e: string | null) => isAdminEmailMock(e),
}));
vi.mock("@/lib/data/users", () => ({
  getUserRole: (id: string) => getUserRoleMock(id),
  isUserSoftDeleted: (id: string) => isUserSoftDeletedMock(id),
}));

async function load() {
  return await import("../../lib/auth/resolveViewer");
}

beforeEach(() => {
  vi.resetModules();
  for (const m of [
    authMock,
    currentUserMock,
    isClerkConfiguredMock,
    getUserRoleMock,
    isUserSoftDeletedMock,
    isAdminEmailMock,
    redirectMock,
  ]) {
    m.mockReset();
  }
});

describe("resolveViewer", () => {
  it("mock-first (sem Clerk) => anon, sem tocar nada", async () => {
    isClerkConfiguredMock.mockReturnValue(false);
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "anon" });
    expect(authMock).not.toHaveBeenCalled();
  });

  it("sem sessao => anon", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: null });
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "anon" });
    expect(getUserRoleMock).not.toHaveBeenCalled();
  });

  it("role 'cliente' no espelho => cliente (1 leitura de DB, sem currentUser)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u1" });
    getUserRoleMock.mockResolvedValue("cliente");
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "cliente", userId: "u1" });
    expect(currentUserMock).not.toHaveBeenCalled();
    expect(isUserSoftDeletedMock).not.toHaveBeenCalled();
  });

  it("role 'admin' => admin (classificacao; o redirect manda para /admin)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u2" });
    getUserRoleMock.mockResolvedValue("admin");
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "admin", userId: "u2" });
  });

  it("role null + soft-deleted => deleted (nao vai ao painel: evitaria loop)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u3" });
    getUserRoleMock.mockResolvedValue(null);
    isUserSoftDeletedMock.mockResolvedValue(true);
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "deleted" });
  });

  it("role null + nao-deletado + email na allowlist => admin (fallback ADMIN_EMAILS)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u4" });
    getUserRoleMock.mockResolvedValue(null);
    isUserSoftDeletedMock.mockResolvedValue(false);
    currentUserMock.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "dono@loja.com" },
      emailAddresses: [],
    });
    isAdminEmailMock.mockReturnValue(true);
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "admin", userId: "u4" });
  });

  it("role null + nao-deletado + email comum => cliente (recem-criado sem sync)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u5" });
    getUserRoleMock.mockResolvedValue(null);
    isUserSoftDeletedMock.mockResolvedValue(false);
    currentUserMock.mockResolvedValue({
      primaryEmailAddress: { emailAddress: "novo@cliente.com" },
      emailAddresses: [],
    });
    isAdminEmailMock.mockReturnValue(false);
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "cliente", userId: "u5" });
  });

  it("role null + nao-deletado + SEM e-mail (currentUser vazio) => anon (nao fabrica cliente)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u7" });
    getUserRoleMock.mockResolvedValue(null);
    isUserSoftDeletedMock.mockResolvedValue(false);
    currentUserMock.mockResolvedValue({ primaryEmailAddress: null, emailAddresses: [] });
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "anon" });
    // e-mail null curto-circuita a allowlist: isAdminEmail nem e consultado.
    expect(isAdminEmailMock).not.toHaveBeenCalled();
  });

  it("leitura de role falhando => anon (vitrine nunca cai pelo roteamento)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u6" });
    getUserRoleMock.mockRejectedValue(new Error("db fora"));
    const { resolveViewer } = await load();
    expect(await resolveViewer()).toEqual({ kind: "anon" });
  });
});

// Decisao PURA do destino de redirect por papel (sem I/O). Prova a regra nova
// "quem esta logado vive na sua area": admin -> /admin, cliente -> espelho no
// painel, anon/deleted ficam na vitrine (null).
describe("storefrontRedirectTarget", () => {
  const DEST = "/painel/pedidos";

  it("admin => /admin (ignora o destino de cliente)", () => {
    const viewer: Viewer = { kind: "admin", userId: "u1" };
    expect(storefrontRedirectTarget(viewer, DEST)).toBe("/admin");
  });

  it("cliente => espelho no painel (o destino recebido)", () => {
    const viewer: Viewer = { kind: "cliente", userId: "u2" };
    expect(storefrontRedirectTarget(viewer, DEST)).toBe(DEST);
    expect(storefrontRedirectTarget(viewer, "/painel/carrinho")).toBe("/painel/carrinho");
  });

  it("anon => null (fica na vitrine publica)", () => {
    expect(storefrontRedirectTarget({ kind: "anon" }, DEST)).toBeNull();
  });

  it("deleted => null (fica na vitrine; area logada devolveria = loop)", () => {
    expect(storefrontRedirectTarget({ kind: "deleted" }, DEST)).toBeNull();
  });
});

// Guard de layout da vitrine: admin logado NUNCA renderiza a vitrine — vai direto
// para /admin (cobre TODAS as rotas do grupo, inclusive as sem redirect por-pagina).
// Cliente/anon seguem na vitrine (o espelho do cliente e feito por-pagina).
describe("redirectAdminAwayFromStorefront", () => {
  it("admin => redirect('/admin')", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "adm" });
    getUserRoleMock.mockResolvedValue("admin");
    const { redirectAdminAwayFromStorefront } = await load();
    await redirectAdminAwayFromStorefront();
    expect(redirectMock).toHaveBeenCalledWith("/admin");
  });

  it("cliente => NAO redireciona (o espelho no painel e feito por-pagina)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "cli" });
    getUserRoleMock.mockResolvedValue("cliente");
    const { redirectAdminAwayFromStorefront } = await load();
    await redirectAdminAwayFromStorefront();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("anon (mock-first) => NAO redireciona", async () => {
    isClerkConfiguredMock.mockReturnValue(false);
    const { redirectAdminAwayFromStorefront } = await load();
    await redirectAdminAwayFromStorefront();
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

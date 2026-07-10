import { beforeEach, describe, expect, it, vi } from "vitest";

// Roteador vitrine -> painel (lib/auth/resolveViewer): papel EFETIVO do
// visitante. DB-free: boundaries (Clerk, config, users) mockados por caso.
//
// Regra provada: cliente logado => "cliente" (paginas redirecionam ao painel);
// admin NUNCA e redirecionado; soft-deleted vira "deleted" (fica na vitrine —
// mandar ao painel seria loop com o guard de la); falha de leitura => "anon"
// (a vitrine nunca cai por causa do roteamento).

const authMock = vi.fn();
const currentUserMock = vi.fn();
const isClerkConfiguredMock = vi.fn();
const getUserRoleMock = vi.fn();
const isUserSoftDeletedMock = vi.fn();
const isAdminEmailMock = vi.fn();

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

  it("role 'admin' => admin (nunca redirecionado da vitrine)", async () => {
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

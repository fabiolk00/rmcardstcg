import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard do cliente autenticado (lib/auth/requireActiveUser): sessao Clerk +
// espelho local ATIVO. Unitario e DB-free: os tres boundaries (Clerk auth,
// config mock-first e leitura do espelho) sao mockados por caso.
//
// Politica provada aqui:
//  - mock-first (sem Clerk) => guest ok (comportamento pre-existente preservado);
//  - sem sessao => unauthenticated;
//  - espelho com deletedAt => deleted (BLOQUEIA mesmo com sessao Clerk valida);
//  - ausente do espelho => ok (webhook de sync atrasado nunca bloqueia);
//  - leitura do espelho falhando => FAIL-OPEN (defense-in-depth nao derruba a loja).

const authMock = vi.fn();
const isClerkConfiguredMock = vi.fn();
const isUserSoftDeletedMock = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({ auth: () => authMock() }));
vi.mock("@/lib/services/clerk/config", () => ({
  isClerkConfigured: () => isClerkConfiguredMock(),
}));
vi.mock("@/lib/data/users", () => ({
  isUserSoftDeleted: (id: string) => isUserSoftDeletedMock(id),
}));

async function loadGuard() {
  return await import("../../lib/auth/requireActiveUser");
}

beforeEach(() => {
  vi.resetModules();
  authMock.mockReset();
  isClerkConfiguredMock.mockReset();
  isUserSoftDeletedMock.mockReset();
});

describe("requireActiveUser", () => {
  it("mock-first (sem Clerk): guest ok, sem tocar Clerk nem banco", async () => {
    isClerkConfiguredMock.mockReturnValue(false);
    const { requireActiveUser } = await loadGuard();

    const out = await requireActiveUser();
    expect(out).toEqual({ ok: true, userId: "guest" });
    expect(authMock).not.toHaveBeenCalled();
    expect(isUserSoftDeletedMock).not.toHaveBeenCalled();
  });

  it("sem sessao => unauthenticated (sem consultar o espelho)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: null });
    const { requireActiveUser } = await loadGuard();

    const out = await requireActiveUser();
    expect(out).toEqual({ ok: false, reason: "unauthenticated" });
    expect(isUserSoftDeletedMock).not.toHaveBeenCalled();
  });

  it("sessao valida + espelho ATIVO => ok com o clerkUserId", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "user_abc" });
    isUserSoftDeletedMock.mockResolvedValue(false);
    const { requireActiveUser } = await loadGuard();

    const out = await requireActiveUser();
    expect(out).toEqual({ ok: true, userId: "user_abc" });
    expect(isUserSoftDeletedMock).toHaveBeenCalledWith("user_abc");
  });

  it("sessao valida + espelho SOFT-DELETED => bloqueia (deleted)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "user_dead" });
    isUserSoftDeletedMock.mockResolvedValue(true);
    const { requireActiveUser } = await loadGuard();

    const out = await requireActiveUser();
    expect(out).toEqual({ ok: false, reason: "deleted" });
  });

  it("leitura do espelho falhando => FAIL-OPEN (sessao valida segue ok)", async () => {
    isClerkConfiguredMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "user_abc" });
    isUserSoftDeletedMock.mockRejectedValue(new Error("db indisponivel"));
    const { requireActiveUser } = await loadGuard();

    const out = await requireActiveUser();
    expect(out).toEqual({ ok: true, userId: "user_abc" });
  });
});

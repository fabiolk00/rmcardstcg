import { beforeEach, describe, expect, it, vi } from "vitest";

// Actions do perfil do cliente (app/painel/conta/actions.ts): auth via
// requireActiveUser + validacao/normalizacao SERVER-SIDE antes do upsert.
// Unitario e DB-free (molde: require-active-user.test.ts): o guard e a camada
// lib/data/profile sao mockados por caso — nenhum Postgres envolvido.
//
// Politica provada aqui:
//  - guard: unauthenticated erra pedindo login; deleted erra com a mensagem
//    padrao DEACTIVATED_ACCOUNT_ERROR; "guest" (mock-first) salva normalmente;
//  - validacao: obrigatorios name/phone/cep/street/city/state; cep exige 8
//    digitos APOS strip da mascara; state e UF 2 letras (normalizada p/ caixa
//    alta); cpfCnpj opcional aceita vazio e exige 11/14 digitos quando vier;
//  - normalizacao persistida: cep/cpfCnpj so digitos, opcionais vazios -> null;
//  - falha de gravacao da camada de dados propaga o erro para a UI.

const requireActiveUserMock = vi.fn();
const getCustomerProfileMock = vi.fn();
const saveCustomerProfileMock = vi.fn();

vi.mock("@/lib/auth/requireActiveUser", () => ({
  requireActiveUser: () => requireActiveUserMock(),
  DEACTIVATED_ACCOUNT_ERROR: "Conta desativada. Entre em contato com a loja.",
}));
vi.mock("@/lib/data/profile", () => ({
  getCustomerProfile: (id: string) => getCustomerProfileMock(id),
  saveCustomerProfile: (id: string, input: unknown) => saveCustomerProfileMock(id, input),
}));

async function loadActions() {
  return await import("../../app/painel/conta/actions");
}

/** Input completo e valido; os casos sobrescrevem um campo por vez. */
function validInput() {
  return {
    name: "João Silva",
    email: "joao@email.com",
    phone: "(41) 99876-5432",
    cpfCnpj: "123.456.789-09",
    cep: "81310-160",
    street: "Rua das Laranjeiras",
    number: "123",
    complement: "ap 42",
    district: "Portão",
    city: "Curitiba",
    state: "PR",
  };
}

beforeEach(() => {
  vi.resetModules();
  requireActiveUserMock.mockReset();
  getCustomerProfileMock.mockReset();
  saveCustomerProfileMock.mockReset();
  requireActiveUserMock.mockResolvedValue({ ok: true, userId: "guest" });
  saveCustomerProfileMock.mockResolvedValue({ ok: true });
});

describe("getMyProfile", () => {
  it("usuario ativo => devolve o perfil da camada de dados pelo userId da sessao", async () => {
    requireActiveUserMock.mockResolvedValue({ ok: true, userId: "user_abc" });
    const profile = { clerkUserId: "user_abc", name: "João" };
    getCustomerProfileMock.mockResolvedValue(profile);
    const { getMyProfile } = await loadActions();

    await expect(getMyProfile()).resolves.toBe(profile);
    expect(getCustomerProfileMock).toHaveBeenCalledWith("user_abc");
  });

  it("sem sessao => null, sem consultar a camada de dados", async () => {
    requireActiveUserMock.mockResolvedValue({ ok: false, reason: "unauthenticated" });
    const { getMyProfile } = await loadActions();

    await expect(getMyProfile()).resolves.toBeNull();
    expect(getCustomerProfileMock).not.toHaveBeenCalled();
  });
});

describe("saveMyProfile — guard", () => {
  it("unauthenticated => erra pedindo login (nao salva)", async () => {
    requireActiveUserMock.mockResolvedValue({ ok: false, reason: "unauthenticated" });
    const { saveMyProfile } = await loadActions();

    const out = await saveMyProfile(validInput());
    expect(out).toEqual({ ok: false, error: "Faça login para salvar o perfil." });
    expect(saveCustomerProfileMock).not.toHaveBeenCalled();
  });

  it("deleted => DEACTIVATED_ACCOUNT_ERROR (nao salva)", async () => {
    requireActiveUserMock.mockResolvedValue({ ok: false, reason: "deleted" });
    const { saveMyProfile } = await loadActions();

    const out = await saveMyProfile(validInput());
    expect(out).toEqual({
      ok: false,
      error: "Conta desativada. Entre em contato com a loja.",
    });
    expect(saveCustomerProfileMock).not.toHaveBeenCalled();
  });

  it("mock-first: guest salva normalmente (perfil de guest e valido em dev)", async () => {
    const { saveMyProfile } = await loadActions();

    const out = await saveMyProfile(validInput());
    expect(out).toEqual({ ok: true });
    expect(saveCustomerProfileMock).toHaveBeenCalledWith("guest", expect.any(Object));
  });
});

describe("saveMyProfile — validacao", () => {
  it.each([
    ["name", "  ", "Informe o nome."],
    ["phone", "", "Informe o telefone."],
    ["street", "", "Informe o endereço."],
    ["city", "", "Informe a cidade."],
  ] as const)("%s vazio => erro '%s'", async (key, value, error) => {
    const { saveMyProfile } = await loadActions();

    const out = await saveMyProfile({ ...validInput(), [key]: value });
    expect(out).toEqual({ ok: false, error });
    expect(saveCustomerProfileMock).not.toHaveBeenCalled();
  });

  it.each(["8131016", "81310-1601", "", "abcde-fgh"])(
    "cep sem 8 digitos apos strip (%s) => erro",
    async (cep) => {
      const { saveMyProfile } = await loadActions();

      const out = await saveMyProfile({ ...validInput(), cep });
      expect(out).toEqual({ ok: false, error: "Informe um CEP válido (8 dígitos)." });
      expect(saveCustomerProfileMock).not.toHaveBeenCalled();
    },
  );

  it.each(["P", "PRA", "1A", ""])("state que nao e UF 2 letras (%s) => erro", async (state) => {
    const { saveMyProfile } = await loadActions();

    const out = await saveMyProfile({ ...validInput(), state });
    expect(out).toEqual({ ok: false, error: "Informe o estado (UF)." });
    expect(saveCustomerProfileMock).not.toHaveBeenCalled();
  });

  it.each(["123", "123.456.789-0", "123456789012345"])(
    "cpfCnpj presente sem 11/14 digitos (%s) => erro",
    async (cpfCnpj) => {
      const { saveMyProfile } = await loadActions();

      const out = await saveMyProfile({ ...validInput(), cpfCnpj });
      expect(out).toEqual({ ok: false, error: "CPF/CNPJ inválido (11 ou 14 dígitos)." });
      expect(saveCustomerProfileMock).not.toHaveBeenCalled();
    },
  );

  it("cpfCnpj com 14 digitos (CNPJ mascarado) => aceito", async () => {
    const { saveMyProfile } = await loadActions();

    const out = await saveMyProfile({ ...validInput(), cpfCnpj: "12.345.678/0001-90" });
    expect(out).toEqual({ ok: true });
    expect(saveCustomerProfileMock.mock.calls[0]![1]).toMatchObject({
      cpfCnpj: "12345678000190",
    });
  });
});

describe("saveMyProfile — normalizacao persistida", () => {
  it("cep/cpfCnpj perdem a mascara, state sobe p/ caixa alta, opcionais vazios viram null", async () => {
    const { saveMyProfile } = await loadActions();

    const out = await saveMyProfile({
      ...validInput(),
      cep: "81310-160",
      cpfCnpj: "123.456.789-09",
      state: "pr",
      email: "  ",
      number: "",
      complement: "   ",
      district: "",
    });
    expect(out).toEqual({ ok: true });
    expect(saveCustomerProfileMock).toHaveBeenCalledWith("guest", {
      name: "João Silva",
      email: null,
      phone: "(41) 99876-5432",
      cpfCnpj: "12345678909",
      cep: "81310160",
      street: "Rua das Laranjeiras",
      number: null,
      complement: null,
      district: null,
      city: "Curitiba",
      state: "PR",
    });
  });

  it("shape do contrato: o que persiste e o SUPERSET que o checkout preenche", async () => {
    const { saveMyProfile } = await loadActions();

    await saveMyProfile(validInput());
    const persisted = saveCustomerProfileMock.mock.calls[0]![1] as Record<string, unknown>;
    // Campos que o prefill do checkout consome (CONTRACT.md, "Alinhamento
    // Conta -> Checkout"): manter estas chaves e obrigatorio.
    for (const key of ["name", "email", "phone", "cpfCnpj", "cep", "street", "city", "state"]) {
      expect(persisted).toHaveProperty(key);
    }
  });
});

describe("saveMyProfile — falha da camada de dados", () => {
  it("upsert erra => propaga o erro para a UI", async () => {
    saveCustomerProfileMock.mockResolvedValue({
      ok: false,
      error: "Não foi possível salvar o perfil. Tente novamente.",
    });
    const { saveMyProfile } = await loadActions();

    const out = await saveMyProfile(validInput());
    expect(out).toEqual({
      ok: false,
      error: "Não foi possível salvar o perfil. Tente novamente.",
    });
  });
});

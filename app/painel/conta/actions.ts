"use server";

import { DEACTIVATED_ACCOUNT_ERROR, requireActiveUser } from "@/lib/auth/requireActiveUser";
import { getCustomerProfile, saveCustomerProfile, type CustomerProfile } from "@/lib/data/profile";

/**
 * Server actions do perfil/endereco do cliente (/painel/conta).
 *
 * Auth: requireActiveUser (login + espelho ATIVO; soft-deleted bloqueia).
 * Mock-first: sem Clerk cai em "guest" — o perfil de guest e valido em dev.
 *
 * Validacao SERVER-SIDE (nunca confia no client): obrigatorios name/phone/
 * cep/street/city/state; cep com 8 digitos apos strip (a UI exibe NNNNN-NNN);
 * state UF 2 letras; cpfCnpj opcional com 11/14 digitos. Persistencia
 * normalizada: cep/cpfCnpj so digitos, state maiusculo.
 */

/** Shape cru vindo do form (a action normaliza e valida). */
export type ProfileFormInput = {
  name: string;
  email?: string;
  phone: string;
  cpfCnpj?: string;
  cep: string;
  street: string;
  number?: string;
  complement?: string;
  district?: string;
  city: string;
  state: string;
};

export type SaveMyProfileResult = { ok: true } | { ok: false; error: string };

const onlyDigits = (v: string): string => v.replace(/\D/g, "");
const trimOrNull = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Perfil do usuario logado (ou null: sem perfil, sem sessao ou leitura
 * degradada). A page usa para montar os defaults do form.
 */
export async function getMyProfile(): Promise<CustomerProfile | null> {
  const active = await requireActiveUser();
  if (!active.ok) return null;
  return getCustomerProfile(active.userId);
}

/** Valida e normaliza o input; retorna o erro da PRIMEIRA regra violada. */
function validate(
  input: ProfileFormInput,
): { ok: true; data: Parameters<typeof saveCustomerProfile>[1] } | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Informe o nome." };

  const phone = input.phone.trim();
  if (!phone) return { ok: false, error: "Informe o telefone." };

  const cep = onlyDigits(input.cep);
  if (cep.length !== 8) return { ok: false, error: "Informe um CEP válido (8 dígitos)." };

  const street = input.street.trim();
  if (!street) return { ok: false, error: "Informe o endereço." };

  const city = input.city.trim();
  if (!city) return { ok: false, error: "Informe a cidade." };

  const state = input.state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, error: "Informe o estado (UF)." };

  const cpfCnpjRaw = trimOrNull(input.cpfCnpj);
  const cpfCnpj = cpfCnpjRaw === null ? null : onlyDigits(cpfCnpjRaw);
  if (cpfCnpj !== null && cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {
    return { ok: false, error: "CPF/CNPJ inválido (11 ou 14 dígitos)." };
  }

  return {
    ok: true,
    data: {
      name,
      email: trimOrNull(input.email),
      phone,
      cpfCnpj,
      cep,
      street,
      number: trimOrNull(input.number),
      complement: trimOrNull(input.complement),
      district: trimOrNull(input.district),
      city,
      state,
    },
  };
}

/** Salva (upsert) o perfil do usuario logado. */
export async function saveMyProfile(input: ProfileFormInput): Promise<SaveMyProfileResult> {
  const active = await requireActiveUser();
  if (!active.ok) {
    const error =
      active.reason === "deleted" ? DEACTIVATED_ACCOUNT_ERROR : "Faça login para salvar o perfil.";
    return { ok: false, error };
  }

  const parsed = validate(input);
  if (!parsed.ok) return parsed;

  return saveCustomerProfile(active.userId, parsed.data);
}

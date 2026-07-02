import { prisma } from "../db";
import type { CustomerProfileModel } from "../generated/prisma/models";

/**
 * Camada de dados do perfil/endereco do cliente (customer_profiles).
 *
 * Uma linha por usuario Clerk (unique clerk_user_id), gravada pela tela
 * /painel/conta e consumida no prefill do checkout do painel. O form do
 * checkout e um SUBSET destes campos — mudar o shape aqui exige reconciliar
 * o contrato (app/painel/CONTRACT.md).
 *
 * Convencoes de armazenamento: cep com 8 DIGITOS sem mascara (a UI exibe
 * NNNNN-NNN); state em UF 2 letras maiusculas; cpfCnpj so digitos (11/14).
 * A normalizacao/validacao e responsabilidade das actions (server-side).
 *
 * Tolerancia: a LEITURA degrada para null com console.error (producao pode
 * receber o codigo antes da migration — o prefill degrada, nao quebra).
 */
export type CustomerProfile = {
  clerkUserId: string;
  name: string;
  email: string | null;
  phone: string;
  cpfCnpj: string | null;
  /** 8 digitos, sem mascara (formatacao e da UI). */
  cep: string;
  street: string;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string;
  /** UF 2 letras. */
  state: string;
};

/** Dados salvos no upsert (o clerkUserId vem separado, da sessao). */
export type CustomerProfileInput = Omit<CustomerProfile, "clerkUserId">;

function toCustomerProfile(row: CustomerProfileModel): CustomerProfile {
  return {
    clerkUserId: row.clerkUserId,
    name: row.name,
    email: row.email,
    phone: row.phone,
    cpfCnpj: row.cpfCnpj,
    cep: row.cep,
    street: row.street,
    number: row.number,
    complement: row.complement,
    district: row.district,
    city: row.city,
    state: row.state,
  };
}

/**
 * Perfil do usuario ou null (inexistente OU erro de leitura). Tolerante por
 * contrato: tabela ausente/banco indisponivel viram null + console.error — o
 * consumidor (prefill do checkout, tela de conta) degrada para form vazio.
 */
export async function getCustomerProfile(clerkUserId: string): Promise<CustomerProfile | null> {
  try {
    const row = await prisma.customerProfile.findUnique({ where: { clerkUserId } });
    return row ? toCustomerProfile(row) : null;
  } catch (err) {
    console.error(
      "[profile] leitura do perfil falhou (degrada para null):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export type SaveCustomerProfileResult = { ok: true } | { ok: false; error: string };

/**
 * Upsert do perfil por clerkUserId (um perfil por usuario). Diferente da
 * leitura, a ESCRITA reporta a falha ao chamador — o usuario precisa saber
 * que o salvamento nao aconteceu.
 */
export async function saveCustomerProfile(
  clerkUserId: string,
  input: CustomerProfileInput,
): Promise<SaveCustomerProfileResult> {
  try {
    await prisma.customerProfile.upsert({
      where: { clerkUserId },
      create: { clerkUserId, ...input },
      update: { ...input },
    });
    return { ok: true };
  } catch (err) {
    console.error("[profile] gravacao do perfil falhou:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Não foi possível salvar o perfil. Tente novamente." };
  }
}

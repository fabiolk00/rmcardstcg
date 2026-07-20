import type { Form } from "@/components/checkout/CheckoutView";

/**
 * Mapeamento PURO perfil (Conta) -> Form do checkout (contrato do
 * app/painel/CONTRACT.md). Extraido da page para teste sem Next:
 *  - street/number/complement/district 1:1 (o checkout tem campo proprio para
 *    cada um desde que a etiqueta passou a exigir numero e bairro separados);
 *  - cep salvo sem mascara (8 digitos) -> exibicao NNNNN-NNN;
 *  - demais campos 1:1 (null -> "").
 */
export type CustomerProfileLike = {
  name: string;
  email: string | null;
  phone: string;
  cpfCnpj: string | null;
  cep: string;
  street: string;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
};

/** CEP salvo sem mascara (8 digitos) -> exibicao NNNNN-NNN, como a UI do checkout. */
export function formatCep(cep: string): string {
  const digits = cep.replace(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : cep;
}

/** Perfil -> valores iniciais do form do checkout. */
export function toInitialCustomer(profile: CustomerProfileLike): Partial<Form> {
  return {
    name: profile.name,
    email: profile.email ?? "",
    phone: profile.phone,
    cpfCnpj: profile.cpfCnpj ?? "",
    cep: formatCep(profile.cep),
    street: profile.street,
    number: profile.number ?? "",
    complement: profile.complement ?? "",
    district: profile.district ?? "",
    city: profile.city,
    state: profile.state,
  };
}

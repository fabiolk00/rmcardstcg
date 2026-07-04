import type { Form } from "@/components/checkout/CheckoutView";

/**
 * Mapeamento PURO perfil (Conta) -> Form do checkout (contrato do
 * app/painel/CONTRACT.md). Extraido da page para teste sem Next:
 *  - street do checkout = street + ", " + number (+ " " + complement) quando
 *    number existir;
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
  const street = profile.number
    ? `${profile.street}, ${profile.number}${profile.complement ? ` ${profile.complement}` : ""}`
    : profile.street;
  return {
    name: profile.name,
    email: profile.email ?? "",
    phone: profile.phone,
    cpfCnpj: profile.cpfCnpj ?? "",
    cep: formatCep(profile.cep),
    street,
    city: profile.city,
    state: profile.state,
  };
}

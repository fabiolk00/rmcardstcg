// Perfil mock do cliente para a tela Minhas Compras. No F9/F11 vem do usuario
// autenticado (Clerk) + DB; aqui e um perfil de demonstracao.
export type Profile = {
  name: string;
  email: string;
  phone: string;
  cep: string;
  address: string;
};

const PROFILE: Profile = {
  name: "João Silva Pereira",
  email: "joao.silva@email.com",
  phone: "(41) 99876-5432",
  cep: "80000-100",
  address: "Rua das Laranjeiras, 123 — Curitiba/PR",
};

export async function getProfile(): Promise<Profile> {
  return PROFILE;
}

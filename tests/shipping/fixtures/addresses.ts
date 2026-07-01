/**
 * Fixtures de ENDERECOS para a matriz de testes de frete (tests/shipping).
 *
 * CEPs REAIS, curados por macrorregiao (a API de frete so usa o CEP; os demais
 * campos completam um endereco plausivel de entrega). Deterministico: tabela
 * fixa + builder puro — sem random, sem rede.
 *
 * A ORIGEM segue a convencao ja usada no repo (README/testes do SuperFrete):
 * loja em 01310-100 (Av. Paulista, Sao Paulo/SP).
 */

export type Address = {
  id: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  /** Formato NNNNN-NNN. */
  cep: string;
  regiao: "Local" | "Sudeste" | "Sul" | "Nordeste" | "Norte" | "Centro-Oeste";
  /** Area remota de dificil entrega (prazo longo + sobretaxa no modelo). */
  remota: boolean;
};

/** CEP de origem da loja (so digitos), como SUPERFRETE_FROM_CEP. */
export const STORE_FROM_CEP = "01310100";

type Row = [
  id: string,
  cep: string,
  logradouro: string,
  bairro: string,
  cidade: string,
  uf: string,
  regiao: Address["regiao"],
  remota?: boolean,
];

// Tabela curada (CEP real -> endereco). Cobre origem/local, capital e interior
// de cada macrorregiao e areas remotas de dificil entrega.
const ROWS: readonly Row[] = [
  // Local (mesma cidade da loja)
  ["sp-se", "01001-000", "Praça da Sé", "Sé", "São Paulo", "SP", "Local"],
  // Sudeste
  ["sp-holambra", "13825-000", "Rua Campo de Pouso", "Centro", "Holambra", "SP", "Sudeste"],
  ["rj-centro", "20040-020", "Rua da Assembleia", "Centro", "Rio de Janeiro", "RJ", "Sudeste"],
  ["mg-bh", "30130-010", "Avenida Afonso Pena", "Centro", "Belo Horizonte", "MG", "Sudeste"],
  ["es-vitoria", "29010-002", "Avenida Jerônimo Monteiro", "Centro", "Vitória", "ES", "Sudeste"],
  // Sul
  ["pr-curitiba", "80010-000", "Rua XV de Novembro", "Centro", "Curitiba", "PR", "Sul"],
  ["sc-floripa", "88010-400", "Praça XV de Novembro", "Centro", "Florianópolis", "SC", "Sul"],
  ["rs-poa", "90010-150", "Rua dos Andradas", "Centro Histórico", "Porto Alegre", "RS", "Sul"],
  ["rs-gramado", "95670-000", "Avenida Borges de Medeiros", "Centro", "Gramado", "RS", "Sul"],
  // Nordeste
  ["ba-salvador", "40020-000", "Avenida Estados Unidos", "Comércio", "Salvador", "BA", "Nordeste"],
  ["pe-recife", "50030-230", "Avenida Rio Branco", "Recife Antigo", "Recife", "PE", "Nordeste"],
  ["ce-fortaleza", "60025-100", "Rua Major Facundo", "Centro", "Fortaleza", "CE", "Nordeste"],
  // Nordeste remoto (ilha — sobretaxa e prazo longo classicos)
  [
    "pe-noronha",
    "53990-000",
    "Vila dos Remédios",
    "Centro",
    "Fernando de Noronha",
    "PE",
    "Nordeste",
    true,
  ],
  // Norte
  ["am-manaus", "69005-070", "Avenida Eduardo Ribeiro", "Centro", "Manaus", "AM", "Norte"],
  ["pa-belem", "66010-000", "Avenida Presidente Vargas", "Campina", "Belém", "PA", "Norte"],
  // Norte remoto (interior de dificil acesso)
  ["am-humaita", "69800-000", "Rua Monsenhor Coutinho", "Centro", "Humaitá", "AM", "Norte", true],
  [
    "ap-oiapoque",
    "68980-000",
    "Avenida Barão do Rio Branco",
    "Centro",
    "Oiapoque",
    "AP",
    "Norte",
    true,
  ],
  // Centro-Oeste
  ["df-brasilia", "70040-010", "SBN Quadra 1", "Asa Norte", "Brasília", "DF", "Centro-Oeste"],
  ["go-goiania", "74003-010", "Avenida Goiás", "Centro", "Goiânia", "GO", "Centro-Oeste"],
  ["mt-cuiaba", "78005-000", "Avenida Getúlio Vargas", "Centro", "Cuiabá", "MT", "Centro-Oeste"],
];

/** Builder puro e deterministico: numero/complemento derivados do indice (seed fixo). */
function buildAddress(row: Row, index: number): Address {
  const [id, cep, logradouro, bairro, cidade, uf, regiao, remota] = row;
  return {
    id,
    logradouro,
    numero: String(100 + index * 37), // deterministico, plausivel
    complemento: index % 3 === 0 ? `Apto ${10 + index}` : "",
    bairro,
    cidade,
    uf,
    cep,
    regiao,
    remota: remota ?? false,
  };
}

export const ADDRESSES: readonly Address[] = ROWS.map(buildAddress);

/** Busca por id; lanca se a fixture nao existir (erro de teste, nao de integracao). */
export function address(id: string): Address {
  const a = ADDRESSES.find((x) => x.id === id);
  if (!a) throw new Error(`fixture de endereco inexistente: ${id}`);
  return a;
}

// ---- Bordas de CEP (formato/existencia) ----

/** CEPs com FORMATO invalido: o guard da integracao deve devolver [] sem chamar a rede. */
export const INVALID_FORMAT_CEPS = ["123", "1301-000", "abcde-fgh", "013101000", ""] as const;

/** CEP com formato valido mas INEXISTENTE na base dos Correios. */
export const NONEXISTENT_CEP = "99999-999";

/** CEP valido porem NAO ATENDIDO pela transportadora (modalidades voltam com erro). */
export const UNSERVICED_CEP = "00000-000";

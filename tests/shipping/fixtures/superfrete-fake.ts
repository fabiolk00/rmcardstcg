/**
 * Simulador DETERMINISTICO do SuperFrete (POST /api/v0/calculator) para os
 * testes da matriz de frete. Funcao PURA da requisicao -> resposta: sem rede,
 * sem relogio, sem random — a suite e repetivel e barata.
 *
 * O modelo de preco segue a fisica dos Correios (assuncoes documentadas):
 *  - peso FATURAVEL = max(peso real, peso cubado), cubado = volume(cm3)/6000 kg;
 *  - preco cresce com a ZONA (distancia da origem, derivada do prefixo do CEP)
 *    e com o peso faturavel; PAC < SEDEX sempre; prazo SEDEX < PAC;
 *  - areas REMOTAS (Noronha, interior do Norte) tem sobretaxa e prazo extra;
 *  - acima de 30 kg a modalidade volta como item-ERRO (segregada, nao some);
 *  - CEP nao atendido -> itens-erro; CEP inexistente -> HTTP 400;
 *  - SEGURO (ad valorem): use_insurance_value + insurance_value (REAIS) somam
 *    1% do valor declarado ao preco de cada modalidade. Limites CONFIRMADOS no
 *    sandbox real (2026-07-01) e espelhados aqui: piso R$ 24,50 (abaixo, TODAS
 *    as modalidades viram item-erro) e teto POR MODALIDADE (PAC R$ 3.000,
 *    SEDEX R$ 10.000) — segregacao em 200, nunca HTTP 400.
 *
 * Instalado no boundary do fetch (padrao do repo: vi.stubGlobal), entao a
 * integracao REAL (config -> client -> quote -> parse) roda inteira por cima.
 */

import { vi } from "vitest";

import { NONEXISTENT_CEP, UNSERVICED_CEP } from "./addresses";

const onlyDigits = (s: string) => s.replace(/\D/g, "");

// ---- Zonas de distancia a partir da origem 01310-100 (Sao Paulo/SP) ----
// Derivadas do prefixo REAL do CEP de destino (faixas dos Correios por UF).
//  0 = local (municipio de SP) ... 5 = Norte.
export function zoneOf(cepDigits: string): number {
  const p2 = Number(cepDigits.slice(0, 2));
  if (p2 <= 5) return 0; // 01xxx-05xxx: Sao Paulo capital
  if (p2 <= 19) return 1; // Grande SP + interior SP
  if (p2 <= 39) return 2; // RJ/ES (20-29), MG (30-39)
  if (p2 >= 80) return 3; // PR/SC (80-89), RS (90-99)
  if (p2 >= 70 && p2 <= 79) return 3; // Centro-Oeste + TO
  if (p2 >= 40 && p2 <= 65) return 4; // Nordeste (40-59) + CE/PI/MA (60-65)
  return 5; // 66-69: PA/AP/AM/RR/AC (Norte)
}

/** CEPs com sobretaxa/prazo de area remota (fixtures marcadas `remota: true`). */
const REMOTE_CEPS = new Set(["53990000", "69800000", "68980000"]);

/** Limite de peso por modalidade (Correios: 30 kg). */
export const WEIGHT_LIMIT_GRAMS = 30_000;

export type FakeProduct = {
  quantity: number;
  weight: number; // kg
  height: number; // cm
  width: number;
  length: number;
};

export type FakeRequestBody = {
  from?: { postal_code?: string };
  to?: { postal_code?: string };
  services?: string;
  options?: { use_insurance_value?: boolean; insurance_value?: number };
  products?: FakeProduct[];
};

/**
 * Limites de valor declarado do provedor (reais), CONFIRMADOS no sandbox:
 * piso unico e teto por modalidade. Mensagens de erro espelham as reais.
 */
export const INSURANCE_FLOOR_REAIS = 24.5;
export const INSURANCE_CAP_REAIS = { PAC: 3_000, SEDEX: 10_000 } as const;

/** Taxa ad valorem do seguro (centavos): 1% do valor declarado, por modalidade. */
export function insuranceFeeCents(insuranceCents: number): number {
  return insuranceCents > 0 ? Math.round(insuranceCents / 100) : 0;
}

/**
 * Erro de seguro POR MODALIDADE (como o provedor real): piso comum, teto por
 * servico. null = seguro ok para o servico. Exportado p/ o esperado dos testes.
 */
export function insuranceError(service: "PAC" | "SEDEX", insuranceCents: number): string | null {
  if (insuranceCents <= 0) return null; // seguro desligado
  const reais = insuranceCents / 100;
  if (reais < INSURANCE_FLOOR_REAIS) {
    return "Valor segurado é abaixo do limite mínimo de R$ 24,50";
  }
  if (reais > INSURANCE_CAP_REAIS[service]) {
    return `Valor segurado ultrapassa o limite máximo de R$ ${INSURANCE_CAP_REAIS[service]},00`;
  }
  return null;
}

/** Peso faturavel (g) do pacote consolidado: max(real, cubado a 6000 cm3/kg). */
export function billableGrams(products: FakeProduct[]): number {
  const actual = products.reduce((s, p) => s + Math.round(p.weight * 1000) * p.quantity, 0);
  const volumeCm3 = products.reduce((s, p) => s + p.height * p.width * p.length * p.quantity, 0);
  const cubed = Math.round(volumeCm3 / 6);
  return Math.max(actual, cubed);
}

type Service = { id: 1 | 2; name: "PAC" | "SEDEX" };
const SERVICES: readonly Service[] = [
  { id: 1, name: "PAC" },
  { id: 2, name: "SEDEX" },
];

/** Tabela do modelo (centavos Int). PAC < SEDEX em todos os componentes. */
const TABLE = {
  PAC: { base: 1590, perZone: 430, perStep: 20, remote: 1500 },
  SEDEX: { base: 2390, perZone: 710, perStep: 32, remote: 2600 },
} as const;

export type ExpectedService = {
  id: number;
  name: string;
  priceCents: number | null;
  days: number | null;
  error: string | null;
};

/**
 * Modelo de preco/prazo por modalidade — exportado para os testes calcularem o
 * ESPERADO de forma independente da resposta (mesma funcao pura, zero drift).
 */
export function expectedServices(
  toCepRaw: string,
  products: FakeProduct[],
  insuranceCents = 0,
): ExpectedService[] {
  const toCep = onlyDigits(toCepRaw);
  if (toCep === onlyDigits(UNSERVICED_CEP)) {
    return SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      priceCents: null,
      days: null,
      error: "CEP de destino não atendido pela transportadora.",
    }));
  }
  const grams = billableGrams(products);
  if (grams > WEIGHT_LIMIT_GRAMS) {
    return SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      priceCents: null,
      days: null,
      error: "Peso do pacote excede o limite de 30 kg da modalidade.",
    }));
  }
  const zone = zoneOf(toCep);
  const remote = REMOTE_CEPS.has(toCep);
  const steps = Math.ceil(grams / 100); // degraus de 100 g (discrimina cubagem fina)
  return SERVICES.map((s) => {
    // Piso/teto de seguro POR MODALIDADE (comportamento real): segrega so o
    // servico que estoura; o outro segue cotavel.
    const insErr = insuranceError(s.name, insuranceCents);
    if (insErr) return { id: s.id, name: s.name, priceCents: null, days: null, error: insErr };
    const t = TABLE[s.name];
    const priceCents =
      t.base +
      zone * t.perZone +
      steps * t.perStep +
      (remote ? t.remote : 0) +
      insuranceFeeCents(insuranceCents);
    const days =
      s.name === "PAC" ? 3 + zone * 2 + (remote ? 7 : 0) : Math.max(1, zone) + (remote ? 4 : 0);
    return { id: s.id, name: s.name, priceCents, days, error: null };
  });
}

/** Corpo de resposta no shape do sandbox (price string US "23.50"; erro segregado). */
function responseBody(body: FakeRequestBody): { status: number; json: unknown } {
  const toCep = onlyDigits(body.to?.postal_code ?? "");
  const fromCep = onlyDigits(body.from?.postal_code ?? "");
  const products = body.products ?? [];

  // Validacao de payload (como o provedor real): pega bug de unidade/shape na fonte.
  if (fromCep.length !== 8 || toCep.length !== 8) {
    return { status: 400, json: { message: "CEP inválido." } };
  }
  if (products.length === 0) {
    return { status: 400, json: { message: "Informe ao menos um produto." } };
  }
  for (const p of products) {
    const dimsOk = [p.height, p.width, p.length].every(
      (d) => Number.isFinite(d) && d > 0 && d <= 150,
    );
    // Peso por item em KG: > 120 kg so acontece se o caller mandar GRAMAS (bug de unidade).
    const weightOk = Number.isFinite(p.weight) && p.weight > 0 && p.weight <= 120;
    if (!dimsOk || !weightOk || !Number.isInteger(p.quantity) || p.quantity <= 0) {
      return { status: 400, json: { message: "Produto com peso/medidas inválidos." } };
    }
  }
  if (toCep === onlyDigits(NONEXISTENT_CEP)) {
    return { status: 400, json: { message: "CEP de destino não encontrado." } };
  }

  // Seguro: ligado exige valor declarado numerico valido; os LIMITES (piso/teto)
  // sao aplicados por modalidade em expectedServices, como o provedor real.
  const insured = body.options?.use_insurance_value === true;
  const insuranceReais = Number(body.options?.insurance_value ?? 0);
  if (insured && (!Number.isFinite(insuranceReais) || insuranceReais <= 0)) {
    return { status: 400, json: { message: "Seguro habilitado sem valor declarado." } };
  }
  const insuranceCents = insured ? Math.round(insuranceReais * 100) : 0;

  const services = expectedServices(toCep, products, insuranceCents);
  const json = services.map((s) =>
    s.error
      ? { id: s.id, name: s.name, company: { name: "Correios" }, error: s.error }
      : {
          id: s.id,
          name: s.name,
          company: { name: "Correios" },
          price: (s.priceCents! / 100).toFixed(2),
          delivery_time: s.days,
        },
  );
  return { status: 200, json };
}

export type CapturedCall = { url: string; body: FakeRequestBody };

/**
 * Instala o simulador no boundary do fetch (padrao do repo) e devolve as
 * chamadas capturadas para asserts de payload. Desinstale com
 * vi.unstubAllGlobals() no afterEach.
 */
export function installSuperFreteFake(): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as FakeRequestBody;
      calls.push({ url: String(url), body });
      const { status, json } = responseBody(body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { calls };
}

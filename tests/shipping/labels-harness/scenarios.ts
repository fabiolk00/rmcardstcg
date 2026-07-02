import { getInsuranceLimits } from "@/lib/services/superfrete/config";
import type {
  CreateLabelInput,
  LabelAddress,
  LabelErrorCode,
  LabelPackage,
} from "@/lib/services/superfrete/label-types";

import { address } from "../fixtures/addresses";
import { pkgOf, product } from "../fixtures/products";

/**
 * Os 5 CENARIOS do programa de etiquetas (harness B), reusando as fixtures de
 * produto/endereco de tests/shipping/fixtures. Deterministicos: tabela fixa,
 * nada aleatorio; o ambiente so entra no CEP de origem (SUPERFRETE_FROM_CEP,
 * com fallback) e nos limites de seguro (getInsuranceLimits, env-override).
 *
 * externalRef segue o prefixo reservado ao harness no sandbox:
 * rmcards-harness-<n>-<slug> (LABEL-CONTRACT.md, secao de identificadores).
 * Total de etiquetas PAGAS: 4 (dentro da franquia de 5 do sandbox).
 */

const onlyDigits = (s: string) => s.replace(/\D/g, "");

/** CPF de TESTE valido (digitos verificadores corretos) — destinatarios do harness. */
export const TEST_RECIPIENT_CPF = "52998224725";

/** CEP fallback da loja: Rua Eduardo Sprada, Campo Comprido, Curitiba/PR. */
const FALLBACK_FROM_CEP = "81310160";

/** Remetente FIXO da loja (o CEP vem do ambiente, com fallback documentado). */
export function storeSender(): LabelAddress {
  return {
    name: "RM Cards",
    document: "07807871962",
    address: "Rua Eduardo Sprada",
    number: "100",
    district: "Campo Comprido",
    city: "Curitiba",
    stateAbbr: "PR",
    postalCode: process.env.SUPERFRETE_FROM_CEP || FALLBACK_FROM_CEP,
  };
}

/** Destinatario a partir da fixture de endereco (CPF de teste valido por default). */
function recipient(fixtureId: string, overrides?: Partial<LabelAddress>): LabelAddress {
  const a = address(fixtureId);
  return {
    name: "Cliente Teste Harness",
    document: TEST_RECIPIENT_CPF,
    address: a.logradouro,
    number: a.numero,
    ...(a.complemento ? { complement: a.complemento } : {}),
    district: a.bairro,
    city: a.cidade,
    stateAbbr: a.uf,
    postalCode: a.cep,
    ...overrides,
  };
}

/** Criterios que o motor valida em getLabelInfo (esperado vs obtido). */
export type ScenarioExpectation = {
  serviceCode: number;
  /** Valor declarado JA com o clamp piso/teto aplicado (o que o envio deve registrar). */
  declaredValueCents: number;
  fromPostalCode: string;
  toPostalCode: string;
  toName: string;
  toDocument: string;
  pkg: LabelPackage;
};

export type PositiveScenario = {
  kind: "positive";
  n: number;
  slug: string;
  externalRef: string;
  /** true = o motor chama createLabel 2x e exige reused=true + mesmo id na 2a. */
  idempotencyCheck: boolean;
  input: CreateLabelInput;
  expected: ScenarioExpectation;
};

export type NegativeScenario = {
  kind: "negative";
  n: number;
  slug: string;
  externalRef: string;
  input: CreateLabelInput;
  /** Codigo de erro esperado — e NENHUM envio pode ser criado. */
  expectedErrorCode: LabelErrorCode;
};

export type HarnessScenario = PositiveScenario | NegativeScenario;

/** Quantidade de etiquetas PAGAS do programa (guard de saldo/franquia do motor). */
export const PAID_LABELS_COUNT = 4;

export type BuildScenariosOptions = {
  /**
   * Sufixo opcional no externalRef (ex.: "-run2") para re-execucoes no sandbox:
   * o ref fixo dedupa contra etiquetas ja CANCELADAS de rodadas anteriores.
   * Default "" = formato exato do programa.
   */
  refSuffix?: string;
};

/**
 * Monta os 5 cenarios (ambiente lido AQUI, na chamada — compativel com o padrao
 * do repo de configurar env antes do uso).
 */
export function buildScenarios(opts?: BuildScenariosOptions): HarnessScenario[] {
  const suffix = opts?.refSuffix ?? "";
  const from = storeSender();
  const limits = getInsuranceLimits();
  const clamp = (cents: number) =>
    cents <= 0 ? 0 : Math.min(Math.max(cents, limits.minCents), limits.maxCents);

  const positive = (
    n: number,
    slug: string,
    sku: string,
    destId: string,
    serviceCode: number,
    extra?: { idempotencyCheck?: boolean },
  ): PositiveScenario => {
    const p = product(sku);
    const to = recipient(destId);
    const pkg: LabelPackage = pkgOf(sku);
    const externalRef = `rmcards-harness-${n}-${slug}${suffix}`;
    return {
      kind: "positive",
      n,
      slug,
      externalRef,
      idempotencyCheck: extra?.idempotencyCheck ?? false,
      input: {
        externalRef,
        serviceCode,
        from,
        to,
        items: [{ name: p.name, quantity: 1, unitPriceCents: p.priceCents }],
        pkg,
        // Valor CRU da mercadoria: a implementacao re-clampa defensivamente
        // (piso/teto do provedor) — o esperado abaixo ja reflete o clamp.
        declaredValueCents: p.priceCents,
      },
      expected: {
        serviceCode,
        declaredValueCents: clamp(p.priceCents),
        fromPostalCode: onlyDigits(from.postalCode),
        toPostalCode: onlyDigits(to.postalCode),
        toName: to.name,
        toDocument: onlyDigits(to.document),
        pkg,
      },
    };
  };

  // 5) negativo: destinatario SEM document -> erro "validation" LOCAL, sem envio
  // criado (catalogo vazio para este cenario; estado consistente no provedor).
  const negProduct = product("BST-SV-001");
  const negRef = `rmcards-harness-5-sem-document${suffix}`;
  const negative: NegativeScenario = {
    kind: "negative",
    n: 5,
    slug: "sem-document",
    externalRef: negRef,
    input: {
      externalRef: negRef,
      serviceCode: 1,
      from,
      to: recipient("mg-bh", { document: "" }),
      items: [{ name: negProduct.name, quantity: 1, unitPriceCents: negProduct.priceCents }],
      pkg: pkgOf("BST-SV-001"),
      declaredValueCents: negProduct.priceCents,
    },
    expectedErrorCode: "validation",
  };

  return [
    // 1) baseline: carta avulsa leve p/ destino proximo, PAC; declarado de R$ 5
    // e ELEVADO ao piso pelo clamp (prova o re-clamp defensivo fim-a-fim).
    positive(1, "baseline-pac", "SGL-BULK-001", "pr-curitiba", 1, { idempotencyCheck: true }),
    // 2) booster box p/ destino distante, SEDEX (peso/cubagem relevantes).
    positive(2, "booster-box-sedex", "BBX-SV-001", "ba-salvador", 2),
    // 3) carta rara R$ 2.500 p/ RJ, PAC: valor declarado fim-a-fim (250000).
    positive(3, "carta-rara-declarado", "SGL-RARE-001", "rj-centro", 1),
    // 4) modalidade selecionada: deck emitido em SEDEX — a etiqueta reflete a
    // modalidade ESCOLHIDA (serviceCode 2), nao a mais barata.
    positive(4, "modalidade-sedex", "DCK-PRE-001", "pe-recife", 2),
    negative,
  ];
}

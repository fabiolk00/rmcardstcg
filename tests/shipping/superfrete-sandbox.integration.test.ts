import { describe, expect, it } from "vitest";

import { fetchQuote, parseQuote } from "../../lib/services/superfrete/quote";
import { toQuoteRecords } from "../../lib/services/superfrete/record";
import { CATEGORY_PACKAGE } from "../../lib/services/superfrete/dimensions";

/**
 * Teste de INTEGRACAO real contra o sandbox do SuperFrete (Fase 4). Isolado e
 * CONDICIONAL: so roda quando SUPERFRETE_TOKEN e SUPERFRETE_FROM_CEP estao no ambiente
 * (use o token de SANDBOX). Sem isso, a suite inteira e pulada — nunca quebra o CI
 * mock-first nem exige segredo versionado.
 *
 * Objetivo do gate: a resposta real PARSEIA 100% nos modelos. Se algum nome de campo
 * do contrato provisorio divergir do real (price/delivery_time/company.name/error), os
 * asserts abaixo apontam onde ajustar os modelos/mocks.
 *
 * Como rodar:
 *   SUPERFRETE_TOKEN=<sandbox> SUPERFRETE_FROM_CEP=01310100 \
 *   SUPERFRETE_API_URL=https://sandbox.superfrete.com npx vitest run tests/shipping/superfrete-sandbox.integration.test.ts
 */

const ENABLED = Boolean(process.env.SUPERFRETE_TOKEN && process.env.SUPERFRETE_FROM_CEP);

// CEP de destino estavel para a cotacao de prova (centro de Curitiba).
const DEST_CEP = process.env.SUPERFRETE_TEST_TO_CEP ?? "80010000";
// Um item real do catalogo (ETB) — pacote coerente para a API aceitar.
const ITEMS = [{ quantity: 1, pkg: CATEGORY_PACKAGE["Elite Trainer Box"] }];

describe.skipIf(!ENABLED)("SuperFrete sandbox (integração real)", () => {
  it("a resposta crua parseia 100% nos modelos (valida o contrato provisório)", async () => {
    const fetched = await fetchQuote(DEST_CEP, ITEMS);
    expect(fetched).not.toBeNull();
    if (!fetched) return;

    // A resposta DEVE ser um array (um item por modalidade).
    expect(Array.isArray(fetched.raw)).toBe(true);

    const { options, unavailable } = parseQuote(fetched.raw);
    // Em muitos CEPs so vem Correios; o minimo e que ALGO foi segregado (cotavel ou nao).
    expect(options.length + unavailable.length).toBeGreaterThan(0);

    // Toda opcao cotavel: preco em centavos Int > 0 e nome nao-vazio (contrato: price/name).
    for (const o of options) {
      expect(Number.isInteger(o.priceCents)).toBe(true);
      expect(o.priceCents).toBeGreaterThan(0);
      expect(typeof o.name).toBe("string");
      expect(o.name.length).toBeGreaterThan(0);
      expect(o.days === null || (Number.isInteger(o.days) && o.days > 0)).toBe(true);
    }
    // Toda indisponivel carrega o motivo (contrato: campo `error` em vez de price).
    for (const u of unavailable) {
      expect(typeof u.reason).toBe("string");
      expect(u.reason.length).toBeGreaterThan(0);
    }
  });

  it("seguro/valor declarado: aceito pelo provedor e custo nao-diminui com valor maior (R$5 vs R$2.500)", async () => {
    // MESMO pacote fisico (carta em toploader+envelope) e destino; so o valor
    // da mercadoria muda. Evidencia da Fase de validacao: o provedor aceita o
    // insurance_value e o custo reflete o seguro (delta logado por modalidade).
    const pkg = { weightGrams: 20, lengthCm: 16, widthCm: 11, heightCm: 1 };
    const cheap = await fetchQuote(DEST_CEP, [{ quantity: 1, pkg, unitPriceCents: 500 }]);
    const rare = await fetchQuote(DEST_CEP, [{ quantity: 1, pkg, unitPriceCents: 250_000 }]);
    expect(cheap).not.toBeNull();
    expect(rare).not.toBeNull();
    if (!cheap || !rare) return;

    // Aceito = resposta 200 parseavel com ao menos uma modalidade cotavel (um 400
    // de campo invalido teria lancado SuperFreteError antes).
    const cheapOptions = parseQuote(cheap.raw).options;
    const rareOptions = parseQuote(rare.raw).options;
    expect(cheapOptions.length).toBeGreaterThan(0);
    expect(rareOptions.length).toBeGreaterThan(0);

    for (const o of rareOptions) {
      const base = cheapOptions.find((c) => c.serviceCode === o.serviceCode);
      if (!base) continue;
      console.info("[sandbox-evidencia] seguro reflete no custo", {
        service: o.name,
        cheapCents: base.priceCents,
        rareCents: o.priceCents,
        deltaCents: o.priceCents - base.priceCents,
      });
      // Ad valorem: valor declarado maior nunca barateia; para R$2.500 vs R$5
      // espera-se delta ESTRITAMENTE positivo em ao menos uma modalidade.
      expect(o.priceCents).toBeGreaterThanOrEqual(base.priceCents);
    }
    const anyStrictIncrease = rareOptions.some((o) => {
      const base = cheapOptions.find((c) => c.serviceCode === o.serviceCode);
      return base != null && o.priceCents > base.priceCents;
    });
    expect(anyStrictIncrease).toBe(true);
  });

  it("o registro normalizado e plano e consistente (valor cotado vs pós-conferência)", async () => {
    const records = await toQuoteRecordsFromLive();
    expect(records.length).toBeGreaterThan(0);

    for (const r of records) {
      // Plano/tabular: nenhum campo e objeto/array aninhado.
      for (const v of Object.values(r)) {
        expect(typeof v !== "object" || v === null).toBe(true);
      }
      // Valor pós-conferência e SEMPRE distinto do cotado e null na cotacao.
      expect(r.postAuditPriceCents).toBeNull();
      // Coerencia available <-> quotedPriceCents.
      if (r.available) {
        expect(r.quotedPriceCents).not.toBeNull();
        expect(r.unavailableReason).toBeNull();
      } else {
        expect(r.quotedPriceCents).toBeNull();
        expect(typeof r.unavailableReason).toBe("string");
      }
      // Metadados de observabilidade presentes.
      expect(typeof r.requestId).toBe("string");
      expect(r.fromCep.length).toBe(8);
      expect(r.toCep.length).toBe(8);
    }
  });
});

/** Cota ao vivo e materializa os registros (compartilhado pelos casos). */
async function toQuoteRecordsFromLive() {
  const fetched = await fetchQuote(DEST_CEP, ITEMS);
  if (!fetched) return [];
  return toQuoteRecords(fetched);
}

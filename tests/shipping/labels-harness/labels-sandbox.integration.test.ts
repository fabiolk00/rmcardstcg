import { describe, expect, it } from "vitest";

import type { LabelModule } from "@/lib/services/superfrete/label-types";

import { runLabelHarness } from "./engine";

/**
 * PORTAO de integracao REAL: motor do harness x modulo de etiquetas do Agente A
 * contra o SANDBOX do SuperFrete. Isolado e CONDICIONAL (padrao do repo,
 * superfrete-sandbox.integration.test.ts): so roda com SUPERFRETE_TOKEN +
 * SUPERFRETE_FROM_CEP no ambiente (token de SANDBOX). Sem env, a suite inteira
 * e pulada — nunca quebra o CI mock-first nem exige segredo versionado.
 *
 * Efeitos no sandbox: cria e PAGA 4 etiquetas (dentro da franquia de 5) e
 * CANCELA todas na limpeza (estorno). Sem cobertura de saldo/franquia o motor
 * aborta sem criar nada (recarregue via Pix simulado no painel sandbox).
 *
 * Como rodar (orquestrador, no portao):
 *   SUPERFRETE_TOKEN=<sandbox> SUPERFRETE_FROM_CEP=81310160 \
 *   SUPERFRETE_API_URL=https://sandbox.superfrete.com \
 *   npx vitest run tests/shipping/labels-harness/labels-sandbox.integration.test.ts
 */

const ENABLED = Boolean(process.env.SUPERFRETE_TOKEN && process.env.SUPERFRETE_FROM_CEP);

// TRAVA DE AMBIENTE: este teste CRIA E PAGA etiquetas. Diferente dos testes
// read-only, exige URL explicitamente de SANDBOX — com credencial/URL de
// producao no ambiente, 4 etiquetas custariam dinheiro REAL (e o cancelamento
// vira credito preso na carteira, nao volta ao banco).
const API_URL = process.env.SUPERFRETE_API_URL ?? "";
const IS_SANDBOX = /(^|\/\/)sandbox\.superfrete\.com/.test(API_URL);

describe.skipIf(!ENABLED)("SuperFrete etiquetas — harness no sandbox (integracao real)", () => {
  it(
    "cria/valida/imprime/cancela os 5 cenarios e imprime o [harness-report]",
    { timeout: 120_000 },
    async () => {
      expect(
        IS_SANDBOX,
        `SUPERFRETE_API_URL deve apontar EXPLICITAMENTE para o sandbox (got: "${API_URL}") — ` +
          "este teste paga etiquetas; nunca rode contra producao.",
      ).toBe(true);
      // Import dinamico DENTRO do teste: o modulo real pertence ao Agente A e pode
      // nao existir enquanto ele nao termina — sem env este corpo nem executa,
      // entao a colecao nunca quebra. O @ts-ignore cobre o typecheck ate la (vira
      // no-op quando lib/services/superfrete/labels.ts existir).
      // @ts-ignore -- modulo do Agente A (contrato congelado em label-types.ts)
      const labels = (await import("@/lib/services/superfrete/labels")) as {
        superFreteLabels: LabelModule;
      };

      // Sufixo unico por rodada: re-execucoes nao colidem com refs de rodadas
      // anteriores no sandbox (painel legivel; dedupe nunca "reusa" cancelada).
      const refSuffix = `-r${Date.now().toString(36)}`;
      const report = await runLabelHarness(labels.superFreteLabels, {
        realQuote: true,
        refSuffix,
      });

      // O relatorio SEMPRE sai antes dos asserts: e a evidencia do portao
      // (ids, precos, carteira antes/depois, observacoes, inconsistencias).
      console.info("[harness-report]", JSON.stringify(report));

      // Sem cobertura de saldo/franquia o abort e instrucao operacional, nao bug.
      expect(report.aborted, report.abortReason ?? "").toBe(false);

      // Criterios do programa como asserts DUROS: qualquer divergencia
      // (remetente/destinatario/pkg/servico/declarado/status/idempotencia/
      // negativo/limpeza/estorno) ja foi coletada pelo motor com evidencia.
      expect(report.inconsistencies).toEqual([]);

      expect(report.rows).toHaveLength(5);
      const paid = report.rows.filter((r) => r.superFreteId !== null);
      expect(paid).toHaveLength(4); // dentro da franquia de 5 do sandbox
      for (const r of paid) {
        expect(r.priceCents).toBeGreaterThan(0);
        expect(r.printUrl).toBeTruthy(); // artefato imprimivel emitido
        expect(r.canceled).toBe(true); // limpeza: nenhuma etiqueta fica ativa
        expect(r.refunded).toBe(true); // paga estorna p/ carteira
      }

      // Cenario 3: valor declarado fim-a-fim (R$ 2.500 = 250000 centavos no envio).
      const rara = report.rows.find((r) => r.scenario.includes("carta-rara"));
      expect(rara?.declaredValueCents).toBe(250_000);

      // Cenario 4: etiqueta reflete a modalidade ESCOLHIDA (SEDEX), nao a mais barata.
      const sedex = report.rows.find((r) => r.scenario.includes("modalidade-sedex"));
      expect(sedex?.service).toBe(2);

      // Cenario 5 (negativo): NENHUM envio criado.
      const negativo = report.rows.find((r) => r.scenario.includes("sem-document"));
      expect(negativo?.superFreteId).toBeNull();

      // Tracking vazio e delta cotacao-vs-etiqueta sao OBSERVACOES (notes/
      // observations no relatorio), nunca falha dura — criterio do programa.
    },
  );
});

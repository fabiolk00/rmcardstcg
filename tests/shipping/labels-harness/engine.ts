import type {
  LabelModule,
  LabelStatus,
  WalletBalance,
} from "@/lib/services/superfrete/label-types";

import {
  buildScenarios,
  PAID_LABELS_COUNT,
  type NegativeScenario,
  type PositiveScenario,
} from "./scenarios";

/**
 * MOTOR do harness de etiquetas: roda os 5 cenarios do programa contra QUALQUER
 * LabelModule (stub deterministico ou modulo real no sandbox) e produz um
 * relatorio auditavel. Politica: o motor NUNCA lanca — toda divergencia entra
 * em inconsistencies[] com evidencia (esperado vs obtido) e a LIMPEZA cancela
 * TODO envio criado mesmo com falha no meio (nenhuma etiqueta fica ativa).
 *
 * Fases:
 *  0. carteira antes: sem cobertura (franquia/saldo) p/ as etiquetas pagas,
 *     aborta SEM criar nada (instrucao operacional no abortReason);
 *  1. por cenario positivo: [realQuote opcional] -> createLabel -> idempotencia
 *     (cenario marcado) -> getLabelInfo (criterios) -> printLabel A4 -> tracking
 *     (null e esperado ate a postagem: OBSERVACAO, nao falha);
 *  2. cenario negativo: espera erro tipado "validation" SEM envio criado (envio
 *     criado = falha + id vai pro catalogo p/ limpeza);
 *  3. limpeza (sempre): cancelLabel de todo id do catalogo (estorno esperado
 *     nas pagas) + carteira depois com os numeros crus registrados.
 */

// Estimativa por etiqueta para o guard de saldo (portao real: custo medio
// observado ~R$ 56, maior etiqueta R$ 84,44 — R$ 60 de media cobre o conjunto).
// CONFIRMADO NO PORTAO: limits.shipments_available NAO paga etiqueta (409 "Sem
// saldo na carteira!" com franquia 5 e saldo 0) — o guard e SO por saldo.
export const CUSTO_ESTIMADO_ETIQUETA_CENTS = 6_000;

// Status que contam como PAGOS (pos-checkout): pending = ainda nao pago.
const PAID_STATUSES: readonly LabelStatus[] = ["released", "posted", "delivered"];

export type HarnessRow = {
  /** externalRef do cenario (unico e legivel no painel do sandbox). */
  scenario: string;
  service: number;
  superFreteId: string | null;
  trackingCode: string | null;
  declaredValueCents: number | null;
  priceCents: number | null;
  status: LabelStatus | null;
  printUrl: string | null;
  canceled: boolean;
  refunded: boolean;
  /** Preco cotado (quoteShipping read-only) da modalidade escolhida, se opts.realQuote. */
  quotedPriceCents: number | null;
  /** Observacoes NAO-bloqueantes (tracking vazio, delta cotacao vs etiqueta...). */
  notes: string[];
};

export type HarnessInconsistency = {
  scenario: string;
  expected: unknown;
  got: unknown;
  note: string;
};

export type HarnessReport = {
  aborted: boolean;
  abortReason: string | null;
  rows: HarnessRow[];
  balanceBefore: WalletBalance | null;
  balanceAfter: WalletBalance | null;
  inconsistencies: HarnessInconsistency[];
  /** Todo superFreteId criado (inclusive por engano no negativo) — alvo da limpeza. */
  catalog: string[];
  observations: string[];
};

export type RunLabelHarnessOptions = {
  /**
   * Portao: cota com quoteShipping (read-only) ANTES do create usando o MESMO
   * pkg+declarado e registra cotado vs etiqueta como OBSERVACAO (nao falha dura).
   */
  realQuote?: boolean;
  /**
   * Sufixo dos externalRef (re-execucao no sandbox sem colidir com refs de
   * rodadas anteriores — o dedupe do modulo ignora canceladas, mas refs unicos
   * por rodada mantem o painel legivel e o teste re-executavel).
   */
  refSuffix?: string;
};

/** Extrai o code tipado (validation/insufficient_balance/...) de um erro qualquer. */
function errorCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function walletLine(label: string, w: WalletBalance): string {
  return (
    `${label}: balanceCents=${w.balanceCents} ` +
    `shipmentsAvailable=${w.shipmentsAvailable ?? "null"} shipmentsUsed=${w.shipmentsUsed ?? "null"}`
  );
}

function emptyRow(scenario: string, service: number): HarnessRow {
  return {
    scenario,
    service,
    superFreteId: null,
    trackingCode: null,
    declaredValueCents: null,
    priceCents: null,
    status: null,
    printUrl: null,
    canceled: false,
    refunded: false,
    quotedPriceCents: null,
    notes: [],
  };
}

export async function runLabelHarness(
  module: LabelModule,
  opts?: RunLabelHarnessOptions,
): Promise<HarnessReport> {
  const scenarios = buildScenarios(opts?.refSuffix ? { refSuffix: opts.refSuffix } : undefined);
  const rows: HarnessRow[] = [];
  const inconsistencies: HarnessInconsistency[] = [];
  const catalog: string[] = [];
  const observations: string[] = [];

  // Fase 0 — carteira ANTES. So SALDO paga etiqueta (franquia de limits NAO —
  // confirmado no portao). Sem saldo p/ as 4 pagas: aborta sem criar nada.
  const balanceBefore = await module.getWalletBalance();
  const saldoNecessario = PAID_LABELS_COUNT * CUSTO_ESTIMADO_ETIQUETA_CENTS;
  if (balanceBefore.balanceCents < saldoNecessario) {
    return {
      aborted: true,
      abortReason: "saldo insuficiente — recarregue via Pix simulado no painel sandbox",
      rows: [],
      balanceBefore,
      balanceAfter: balanceBefore,
      inconsistencies: [],
      catalog: [],
      observations: [
        walletLine("carteira antes", balanceBefore),
        `necessario p/ ${PAID_LABELS_COUNT} etiquetas: saldo >= ${saldoNecessario} centavos ` +
          "(estimativa ~R$ 60/etiqueta; franquia de limits nao paga etiqueta)",
      ],
    };
  }

  try {
    for (const scenario of scenarios) {
      if (scenario.kind === "negative") {
        rows.push(await runNegative(module, scenario, catalog, inconsistencies));
      } else {
        rows.push(
          await runPositive(
            module,
            scenario,
            catalog,
            inconsistencies,
            observations,
            opts?.realQuote === true,
          ),
        );
      }
    }
  } catch (err) {
    // Os runners nao lancam; isto so pega bug do proprio motor — reporta, nao mascara.
    inconsistencies.push({
      scenario: "harness",
      expected: "execucao dos cenarios sem excecao",
      got: errorMessage(err),
      note: "erro inesperado no motor — cenarios restantes nao rodaram",
    });
  } finally {
    // LIMPEZA (sempre, mesmo com falha no meio): cancela TODO id criado.
    await cleanup(module, rows, catalog, inconsistencies);
  }

  // Carteira DEPOIS + prova do estorno (numeros crus sempre registrados).
  let balanceAfter: WalletBalance | null = null;
  try {
    balanceAfter = await module.getWalletBalance();
  } catch (err) {
    inconsistencies.push({
      scenario: "harness",
      expected: "getWalletBalance apos a limpeza",
      got: errorMessage(err),
      note: "nao foi possivel ler a carteira depois da limpeza",
    });
  }
  if (balanceAfter) {
    const custoNaoEstornado = rows
      .filter((r) => r.status !== null && PAID_STATUSES.includes(r.status) && !r.refunded)
      .reduce((sum, r) => sum + (r.priceCents ?? 0), 0);
    // Estorno: saldo_depois >= saldo_antes - custo_nao_estornado OU franquia
    // devolvida (com tudo cancelado, a carteira volta ao estado inicial).
    const saldoOk = balanceAfter.balanceCents >= balanceBefore.balanceCents - custoNaoEstornado;
    const franquiaOk =
      (balanceAfter.shipmentsAvailable ?? 0) >= (balanceBefore.shipmentsAvailable ?? 0);
    if (!saldoOk && !franquiaOk) {
      inconsistencies.push({
        scenario: "harness",
        expected:
          `estorno: balanceCents >= ${balanceBefore.balanceCents - custoNaoEstornado} ` +
          `OU shipmentsAvailable >= ${balanceBefore.shipmentsAvailable ?? "null"}`,
        got: {
          balanceCents: balanceAfter.balanceCents,
          shipmentsAvailable: balanceAfter.shipmentsAvailable,
        },
        note: "carteira nao reflete o estorno esperado apos a limpeza",
      });
    }
    observations.push(
      walletLine("carteira antes", balanceBefore),
      walletLine("carteira depois", balanceAfter),
      `custoNaoEstornado=${custoNaoEstornado} centavos`,
    );
  }

  return {
    aborted: false,
    abortReason: null,
    rows,
    balanceBefore,
    balanceAfter,
    inconsistencies,
    catalog,
    observations,
  };
}

async function runPositive(
  module: LabelModule,
  scenario: PositiveScenario,
  catalog: string[],
  inconsistencies: HarnessInconsistency[],
  observations: string[],
  realQuote: boolean,
): Promise<HarnessRow> {
  const row = emptyRow(scenario.externalRef, scenario.input.serviceCode);
  const expected = scenario.expected;
  const diverge = (note: string, exp: unknown, got: unknown) =>
    inconsistencies.push({ scenario: scenario.externalRef, expected: exp, got, note });

  // (portao) Cotacao READ-ONLY antes do create, com o MESMO pkg + declarado cru
  // (mesmo clamp dos dois lados). Falha/omissao aqui e observacao, nunca falha dura.
  if (realQuote) {
    try {
      const { quoteShipping } = await import("@/lib/services/superfrete/quote");
      const options = await quoteShipping(scenario.input.to.postalCode, [
        {
          quantity: 1,
          pkg: scenario.input.pkg,
          ...(scenario.input.declaredValueCents > 0
            ? { unitPriceCents: scenario.input.declaredValueCents }
            : {}),
        },
      ]);
      row.quotedPriceCents =
        options.find((o) => o.serviceCode === scenario.input.serviceCode)?.priceCents ?? null;
      if (row.quotedPriceCents === null) {
        row.notes.push("cotacao read-only nao devolveu a modalidade escolhida (observacao)");
      }
    } catch (err) {
      row.notes.push(`cotacao read-only falhou: ${errorMessage(err)} (observacao)`);
    }
  }

  try {
    const created = await module.createLabel(scenario.input);
    catalog.push(created.superFreteId);
    row.superFreteId = created.superFreteId;
    row.priceCents = created.priceCents;
    row.status = created.status;
    row.trackingCode = created.trackingCode;
    if (created.reused) {
      row.notes.push("createLabel devolveu reused=true na 1a chamada (ref ja existia no provedor)");
    }

    // Idempotencia (cenario marcado): 2a chamada com o MESMO externalRef tem que
    // vir reused=true com o MESMO id — prova sem custo extra de etiqueta.
    if (scenario.idempotencyCheck) {
      const again = await module.createLabel(scenario.input);
      if (!again.reused) {
        diverge(
          "idempotencia: 2a chamada com o mesmo externalRef deveria vir reused=true",
          true,
          again.reused,
        );
      }
      if (again.superFreteId !== created.superFreteId) {
        diverge(
          "idempotencia: 2a chamada criou OUTRO envio (duplicou etiqueta)",
          created.superFreteId,
          again.superFreteId,
        );
        catalog.push(again.superFreteId); // duplicata tambem vai pra limpeza
      }
    }

    // getLabelInfo: criterios do programa (evidencia esperado vs obtido).
    const info = await module.getLabelInfo(created.superFreteId);
    row.declaredValueCents = info.declaredValueCents;
    row.trackingCode = info.trackingCode;
    row.status = info.status;
    if (info.fromPostalCode !== expected.fromPostalCode) {
      diverge("remetente: CEP divergente", expected.fromPostalCode, info.fromPostalCode);
    }
    if (info.toPostalCode !== expected.toPostalCode) {
      diverge("destinatario: CEP divergente", expected.toPostalCode, info.toPostalCode);
    }
    if (info.toName !== expected.toName) {
      diverge("destinatario: nome divergente", expected.toName, info.toName);
    }
    if (info.toDocument !== expected.toDocument) {
      diverge("destinatario: document divergente", expected.toDocument, info.toDocument);
    }
    // Peso e EXATO; dimensoes o provedor NORMALIZA PARA CIMA na emissao
    // (confirmado no portao: 13x9x2 -> 15x10x2, 16x12x10 -> 24x16x10) — abaixo
    // do enviado seria violacao; acima e observacao (repack do provedor).
    if (info.pkg.weightGrams !== expected.pkg.weightGrams) {
      diverge("pkg: peso divergente do fixture", expected.pkg.weightGrams, info.pkg.weightGrams);
    }
    const gotDims = [info.pkg.heightCm, info.pkg.widthCm, info.pkg.lengthCm].sort((a, b) => a - b);
    const expDims = [expected.pkg.heightCm, expected.pkg.widthCm, expected.pkg.lengthCm].sort(
      (a, b) => a - b,
    );
    if (gotDims.some((d, i) => d < expDims[i])) {
      diverge("pkg: dimensao MENOR que a enviada (repack invalido)", expected.pkg, info.pkg);
    } else if (gotDims.some((d, i) => d !== expDims[i])) {
      row.notes.push(
        `provedor normalizou dimensoes: enviado ${JSON.stringify(expected.pkg)} -> ` +
          `etiqueta ${JSON.stringify(info.pkg)} (observacao)`,
      );
    }
    if (info.serviceCode !== expected.serviceCode) {
      diverge(
        "serviceCode divergente (etiqueta nao reflete a modalidade escolhida)",
        expected.serviceCode,
        info.serviceCode,
      );
    }
    if (info.declaredValueCents !== expected.declaredValueCents) {
      diverge(
        "valor declarado divergente (clamp piso/teto esperado)",
        expected.declaredValueCents,
        info.declaredValueCents,
      );
    }
    if (!PAID_STATUSES.includes(info.status)) {
      diverge("status deveria estar PAGO apos createLabel", [...PAID_STATUSES], info.status);
    }
    // Contrato: tracking do provedor fica "" ate a postagem e DEVE virar null no
    // mapeamento — string vazia vazando e violacao (downstream trataria "" como
    // codigo presente). null e o esperado ate a postagem (observacao).
    if (info.trackingCode === "" || created.trackingCode === "") {
      diverge(
        'trackingCode "" viola o contrato (vazio do provedor => null)',
        "null (ou codigo nao-vazio)",
        { created: created.trackingCode, info: info.trackingCode },
      );
    }
    if (info.trackingCode === null) {
      row.notes.push("tracking null — esperado ate a postagem (observacao, nao falha)");
    }

    // printLabel A4: artefato imprimivel com url nao-vazia.
    const printed = await module.printLabel(created.superFreteId, "A4");
    row.printUrl = printed.url || null;
    if (!printed.url) {
      diverge("printLabel A4 devolveu url vazia", "url nao vazia", printed.url);
    }

    if (realQuote && row.quotedPriceCents !== null && row.priceCents !== null) {
      const delta = row.priceCents - row.quotedPriceCents;
      const line =
        `${scenario.externalRef}: cotado=${row.quotedPriceCents} ` +
        `etiqueta=${row.priceCents} delta=${delta} centavos`;
      row.notes.push(`cotacao vs etiqueta: ${line} (observacao)`);
      observations.push(line);
    }
  } catch (err) {
    diverge(
      "cenario positivo falhou com excecao",
      "fluxo create/info/print sem erro",
      errorMessage(err),
    );
  }
  return row;
}

async function runNegative(
  module: LabelModule,
  scenario: NegativeScenario,
  catalog: string[],
  inconsistencies: HarnessInconsistency[],
): Promise<HarnessRow> {
  const row = emptyRow(scenario.externalRef, scenario.input.serviceCode);
  try {
    const created = await module.createLabel(scenario.input);
    // Envio criado = FALHA do modulo; o id vai pro catalogo para a limpeza.
    catalog.push(created.superFreteId);
    row.superFreteId = created.superFreteId;
    row.priceCents = created.priceCents;
    row.status = created.status;
    inconsistencies.push({
      scenario: scenario.externalRef,
      expected: `erro "${scenario.expectedErrorCode}" SEM envio criado`,
      got: `envio criado: ${created.superFreteId}`,
      note: "cenario negativo NAO deveria criar envio (validacao local ausente)",
    });
  } catch (err) {
    const code = errorCode(err);
    if (code !== scenario.expectedErrorCode) {
      inconsistencies.push({
        scenario: scenario.externalRef,
        expected: scenario.expectedErrorCode,
        got: code ?? errorMessage(err),
        note: "codigo de erro divergente no cenario negativo",
      });
    } else {
      row.notes.push(`erro "${code}" recebido como esperado; nenhum envio criado`);
    }
  }
  return row;
}

/** Cancela todo id do catalogo; valida canceled/refunded (paga => estorno). */
async function cleanup(
  module: LabelModule,
  rows: HarnessRow[],
  catalog: string[],
  inconsistencies: HarnessInconsistency[],
): Promise<void> {
  for (const id of catalog) {
    const row = rows.find((r) => r.superFreteId === id) ?? null;
    const scenario = row?.scenario ?? id;
    try {
      const res = await module.cancelLabel(id, "limpeza do harness rmcards");
      if (row) {
        row.canceled = res.canceled;
        row.refunded = res.refunded;
      }
      if (!res.canceled) {
        inconsistencies.push({
          scenario,
          expected: "canceled=true na limpeza",
          got: res,
          note: "cancelamento de limpeza nao confirmou",
        });
      }
      const paga = row?.status != null && PAID_STATUSES.includes(row.status);
      if (paga && !res.refunded) {
        inconsistencies.push({
          scenario,
          expected: "refunded=true (etiqueta paga estorna p/ carteira)",
          got: res,
          note: "estorno nao confirmado no cancelamento",
        });
      }
    } catch (err) {
      inconsistencies.push({
        scenario,
        expected: "cancelLabel sem erro",
        got: errorMessage(err),
        note: "falha na limpeza — etiqueta pode ter ficado ativa no sandbox",
      });
    }
  }
}

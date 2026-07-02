import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateLabelInput, LabelModule } from "@/lib/services/superfrete/label-types";

// Prova o MOTOR (engine) e o STUB deterministicos — SEM rede: o fetch e stubado
// para LANCAR se alguem tentar sair pra internet. Segue o padrao do repo:
// env limpo antes, import dinamico pos-env, unstub + resetModules depois.
//
// O que este arquivo garante (criterios do programa):
//  - os 5 cenarios rodam verdes no stub e o relatorio sai com TODOS os campos;
//  - o cenario negativo NAO cria envio (catalogo vazio p/ ele);
//  - o motor DETECTA violacao de idempotencia e envio criado no negativo;
//  - a limpeza cancela tudo (estorno confirmado: carteira volta ao inicial);
//  - saldo/franquia insuficiente aborta SEM criar nada.

function setEnv() {
  // Cenarios caem no CEP fallback da loja (81310160) e limites default de seguro.
  delete process.env.SUPERFRETE_TOKEN;
  delete process.env.SUPERFRETE_FROM_CEP;
  delete process.env.SUPERFRETE_INSURANCE_MIN_CENTS;
  delete process.env.SUPERFRETE_INSURANCE_MAX_CENTS;
}

/** Fetch que LANCA: nenhum teste deste arquivo pode tocar a rede. */
function banNetwork() {
  const fetchMock = vi.fn(async () => {
    throw new Error("rede proibida no teste deterministico");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Modulos sob teste via import dinamico (padrao do repo: pos-env). */
async function load() {
  const stub = await import("./stub");
  const engine = await import("./engine");
  const scenarios = await import("./scenarios");
  return { ...stub, ...engine, ...scenarios };
}

/** Espera um SuperFreteLabelError (shape estrutural) com o code dado. */
async function expectLabelError(promise: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  expect(caught, `deveria ter lancado erro tipado "${code}"`).toBeTruthy();
  expect((caught as { code?: string }).code).toBe(code);
}

beforeEach(setEnv);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("runLabelHarness x stub — caminho feliz dos 5 cenarios", () => {
  it("roda verde, relatorio completo, limpeza cancela tudo e carteira volta ao inicial", async () => {
    const fetchMock = banNetwork();
    const { makeStub, runLabelHarness } = await load();
    const stub = makeStub();

    const report = await runLabelHarness(stub);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.aborted).toBe(false);
    expect(report.abortReason).toBeNull();
    expect(report.inconsistencies).toEqual([]);
    expect(report.rows).toHaveLength(5);
    expect(report.catalog).toHaveLength(4); // so os positivos criam envio

    // Todos os campos do relatorio presentes em toda linha (shape do programa).
    const expectedKeys = [
      "scenario",
      "service",
      "superFreteId",
      "trackingCode",
      "declaredValueCents",
      "priceCents",
      "status",
      "printUrl",
      "canceled",
      "refunded",
      "quotedPriceCents",
      "notes",
    ];
    for (const row of report.rows) {
      expect(Object.keys(row).sort()).toEqual([...expectedKeys].sort());
    }
    expect(report.balanceBefore).not.toBeNull();
    expect(report.balanceAfter).not.toBeNull();
    expect(report.observations.length).toBeGreaterThan(0);

    // 4 etiquetas pagas: emitidas, imprimiveis (?format=A4), canceladas e estornadas.
    const paid = report.rows.filter((r) => r.superFreteId !== null);
    expect(paid).toHaveLength(4);
    for (const r of paid) {
      expect(r.status).toBe("released");
      expect(r.priceCents).toBeGreaterThan(0);
      expect(r.printUrl).toMatch(/format=A4/);
      expect(r.trackingCode).toBeNull(); // nunca simula postagem
      expect(r.canceled).toBe(true);
      expect(r.refunded).toBe(true);
      expect(r.quotedPriceCents).toBeNull(); // sem opts.realQuote
    }

    // Criterios por cenario.
    const baseline = report.rows.find((r) => r.scenario === "rmcards-harness-1-baseline-pac");
    expect(baseline?.service).toBe(1);
    expect(baseline?.declaredValueCents).toBe(2450); // R$ 5 ELEVADO ao piso pelo clamp
    const rara = report.rows.find((r) => r.scenario === "rmcards-harness-3-carta-rara-declarado");
    expect(rara?.declaredValueCents).toBe(250_000); // valor declarado fim-a-fim
    const sedex = report.rows.find((r) => r.scenario === "rmcards-harness-4-modalidade-sedex");
    expect(sedex?.service).toBe(2); // etiqueta reflete a modalidade escolhida

    // Estorno de verdade no stub: tudo cancelado, carteira volta ao inicial.
    expect(report.balanceAfter?.balanceCents).toBe(report.balanceBefore?.balanceCents);
    expect(report.balanceAfter?.shipmentsAvailable).toBe(5);
    expect(stub.inspect()).toMatchObject({ created: 4, paidActive: 0, canceled: 4 });
  });

  it("cenario negativo (sem document) nao cria envio e registra o erro esperado", async () => {
    banNetwork();
    const { makeStub, runLabelHarness } = await load();
    const stub = makeStub();

    const report = await runLabelHarness(stub);

    const neg = report.rows.find((r) => r.scenario === "rmcards-harness-5-sem-document");
    expect(neg).toBeTruthy();
    expect(neg?.superFreteId).toBeNull();
    expect(neg?.canceled).toBe(false);
    expect(neg?.refunded).toBe(false);
    expect(neg?.notes.join(" ")).toMatch(/validation/);
    expect(report.catalog).not.toContain("stub-rmcards-harness-5-sem-document");
    expect(stub.inspect().ids).not.toContain("stub-rmcards-harness-5-sem-document");
    expect(report.inconsistencies).toEqual([]);
  });
});

describe("runLabelHarness — o motor DETECTA modulo quebrado (nao mascara)", () => {
  it("violacao de idempotencia (2a chamada duplica envio) vira inconsistencia + duplicata limpa", async () => {
    banNetwork();
    const { makeStub, runLabelHarness } = await load();
    const stub = makeStub();
    let calls = 0;
    // Modulo que QUEBRA o dedupe: cada createLabel vira um externalRef novo.
    const broken: LabelModule = {
      createLabel: (input: CreateLabelInput) => {
        calls += 1;
        return stub.createLabel({ ...input, externalRef: `${input.externalRef}--dup${calls}` });
      },
      printLabel: (id, f) => stub.printLabel(id, f),
      cancelLabel: (id, r) => stub.cancelLabel(id, r),
      getWalletBalance: () => stub.getWalletBalance(),
      getLabelInfo: (id) => stub.getLabelInfo(id),
    };

    const report = await runLabelHarness(broken);

    const idem = report.inconsistencies.filter((i) => i.note.includes("idempotencia"));
    expect(idem.length).toBeGreaterThanOrEqual(1); // reused=false e/ou id diferente
    // A etiqueta duplicada entrou no catalogo e foi CANCELADA na limpeza.
    expect(report.catalog).toHaveLength(5);
    expect(stub.inspect().paidActive).toBe(0);
  });

  it("modulo que CRIA envio no cenario negativo e acusado e o id vai pra limpeza", async () => {
    banNetwork();
    const { makeStub, runLabelHarness, TEST_RECIPIENT_CPF } = await load();
    const stub = makeStub();
    // Modulo que "conserta" o destinatario invalido em vez de validar (bug classico).
    const cheating: LabelModule = {
      createLabel: (input: CreateLabelInput) =>
        stub.createLabel(
          input.to.document
            ? input
            : { ...input, to: { ...input.to, document: TEST_RECIPIENT_CPF } },
        ),
      printLabel: (id, f) => stub.printLabel(id, f),
      cancelLabel: (id, r) => stub.cancelLabel(id, r),
      getWalletBalance: () => stub.getWalletBalance(),
      getLabelInfo: (id) => stub.getLabelInfo(id),
    };

    const report = await runLabelHarness(cheating);

    const neg = report.rows.find((r) => r.scenario === "rmcards-harness-5-sem-document");
    expect(neg?.superFreteId).not.toBeNull();
    expect(report.inconsistencies.some((i) => i.note.includes("negativo"))).toBe(true);
    expect(report.catalog).toContain(neg?.superFreteId);
    expect(neg?.canceled).toBe(true); // limpeza cancelou o envio criado por engano
    expect(stub.inspect().paidActive).toBe(0);
  });
});

describe("runLabelHarness — guard de saldo/franquia (fase 0)", () => {
  it("saldo 0 + franquia 0: aborta com instrucao operacional SEM criar nada", async () => {
    banNetwork();
    const { makeStub, runLabelHarness } = await load();
    const stub = makeStub({ balanceCents: 0, shipmentsAvailable: 0 });

    const report = await runLabelHarness(stub);

    expect(report.aborted).toBe(true);
    expect(report.abortReason).toMatch(/saldo insuficiente/);
    expect(report.abortReason).toMatch(/Pix simulado/);
    expect(report.rows).toEqual([]);
    expect(report.catalog).toEqual([]);
    expect(report.inconsistencies).toEqual([]);
    expect(stub.inspect().created).toBe(0);
  });

  it("sem franquia mas com saldo suficiente: roda, consome saldo e estorna tudo na limpeza", async () => {
    banNetwork();
    const { makeStub, runLabelHarness, CUSTO_ESTIMADO_ETIQUETA_CENTS, PAID_LABELS_COUNT } =
      await load();
    const saldo = PAID_LABELS_COUNT * CUSTO_ESTIMADO_ETIQUETA_CENTS + 10_000;
    const stub = makeStub({ balanceCents: saldo, shipmentsAvailable: 0 });

    const report = await runLabelHarness(stub);

    expect(report.aborted).toBe(false);
    expect(report.inconsistencies).toEqual([]);
    expect(report.balanceBefore?.balanceCents).toBe(saldo);
    // Checkout consumiu saldo (etiquetas pagas > 0) e a limpeza estornou TUDO.
    const totalPago = report.rows.reduce((s, r) => s + (r.priceCents ?? 0), 0);
    expect(totalPago).toBeGreaterThan(0);
    expect(report.balanceAfter?.balanceCents).toBe(saldo);
  });
});

describe("stub — semantica do contrato (unidade, sem motor)", () => {
  async function baselineInput(): Promise<CreateLabelInput> {
    const { buildScenarios } = await load();
    const first = buildScenarios()[0];
    if (first.kind !== "positive") throw new Error("cenario 1 deveria ser positivo");
    return structuredClone(first.input);
  }

  it("idempotencia direta: mesmo externalRef -> mesmo id, reused=true, cobra 1x so", async () => {
    banNetwork();
    const { makeStub } = await load();
    const stub = makeStub();
    const input = await baselineInput();

    const first = await stub.createLabel(input);
    const second = await stub.createLabel(input);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.superFreteId).toBe(first.superFreteId);
    expect(second.priceCents).toBe(first.priceCents);
    const wallet = await stub.getWalletBalance();
    expect(wallet.balanceCents).toBe(100_000 - first.priceCents); // saldo cobrado UMA vez
    expect(stub.inspect().created).toBe(1);
  });

  it.each([
    ["sem document", (i: CreateLabelInput) => ({ ...i, to: { ...i.to, document: "" } })],
    [
      "CEP de destino invalido",
      (i: CreateLabelInput) => ({ ...i, to: { ...i.to, postalCode: "1234" } }),
    ],
    [
      "peso acima de 30 kg",
      (i: CreateLabelInput) => ({ ...i, pkg: { ...i.pkg, weightGrams: 38_000 } }),
    ],
    ["items vazio", (i: CreateLabelInput) => ({ ...i, items: [] })],
    [
      "quantity invalida",
      (i: CreateLabelInput) => ({
        ...i,
        items: [{ name: "x", quantity: 0, unitPriceCents: 100 }],
      }),
    ],
  ])("validacao local (%s): lanca validation SEM criar estado", async (_name, mutate) => {
    banNetwork();
    const { makeStub } = await load();
    const stub = makeStub();
    const input = mutate(await baselineInput());

    await expectLabelError(stub.createLabel(input), "validation");
    expect(stub.inspect().created).toBe(0);
    expect((await stub.getWalletBalance()).shipmentsAvailable).toBe(5); // nada cobrado
  });

  it("sem franquia e sem saldo p/ o preco: insufficient_balance sem criar envio", async () => {
    banNetwork();
    const { makeStub } = await load();
    const stub = makeStub({ balanceCents: 100, shipmentsAvailable: 0 });
    const input = await baselineInput();

    await expectLabelError(stub.createLabel(input), "insufficient_balance");
    expect(stub.inspect().created).toBe(0);
    expect((await stub.getWalletBalance()).balanceCents).toBe(100); // saldo intacto
  });

  it("cancelar 2x: 1a estorna (refunded=true), 2a e no-op tolerante (refunded=false)", async () => {
    banNetwork();
    const { makeStub } = await load();
    const stub = makeStub();
    const created = await stub.createLabel(await baselineInput());

    const first = await stub.cancelLabel(created.superFreteId);
    expect(first).toEqual({ canceled: true, refunded: true });
    expect((await stub.getWalletBalance()).balanceCents).toBe(100_000); // estorno integral

    const second = await stub.cancelLabel(created.superFreteId);
    expect(second).toEqual({ canceled: true, refunded: false }); // sem duplo estorno
    expect((await stub.getWalletBalance()).balanceCents).toBe(100_000);
  });

  it("printLabel carrega ?format= (A4 default, A6 explicito); id desconhecido -> provider", async () => {
    banNetwork();
    const { makeStub } = await load();
    const stub = makeStub();
    const created = await stub.createLabel(await baselineInput());

    const a4 = await stub.printLabel(created.superFreteId);
    expect(a4.format).toBe("A4");
    expect(a4.url).toMatch(/\?format=A4$/);
    const a6 = await stub.printLabel(created.superFreteId, "A6");
    expect(a6.format).toBe("A6");
    expect(a6.url).toMatch(/\?format=A6$/);

    await expectLabelError(stub.printLabel("nao-existe"), "provider");
  });

  it("getLabelInfo: tracking null ate a postagem, declarado com clamp e enderecos normalizados", async () => {
    banNetwork();
    const { makeStub } = await load();
    const stub = makeStub();
    const input = await baselineInput(); // declarado cru R$ 5 (500 centavos)
    const created = await stub.createLabel(input);

    const info = await stub.getLabelInfo(created.superFreteId);
    expect(info.trackingCode).toBeNull();
    expect(info.declaredValueCents).toBe(2450); // piso do provedor (clamp eleva)
    expect(info.serviceCode).toBe(1);
    expect(info.fromPostalCode).toBe("81310160"); // fallback da loja, so digitos
    expect(info.toPostalCode).toBe("80010000");
    expect(info.toDocument).toBe("52998224725");
    expect(info.pkg).toEqual(input.pkg);
    expect(info.status).toBe("released"); // pago
  });
});

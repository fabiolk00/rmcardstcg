import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { SHIPPING_TRANSITIONS, allowedShippingTransitions } from "../../lib/data/orderTransitions";

/**
 * Sondas INV-8 — State machines no servidor sao FONTE DE VERDADE.
 *
 * INV-8 exige:
 *  (a) Estados TERMINAIS de envio ('delivered', 'cancelled') nao tem saida valida.
 *      Excecao: 'cancelled' e terminal e nao deve ter saidas.
 *      Atencao: 'delivered' e TERMINAL — nao pode ganhar nenhuma transicao.
 *  (b) Estados TERMINAIS de pagamento ('paid', 'cancelled') obedecem regras estritas:
 *      'paid' pode ir para 'cancelled' (refund) — mas 'cancelled' NUNCA pode ir para 'paid'.
 *      'cancelled' e TERMINAL para o fluxo normal: ressurreicao (cancelled->paid) e proibida.
 *  (c) A reconciliacao seleciona SOMENTE 'pending' — nunca alarga o predicado para outros status.
 *
 * Defeitos alvo desta suite (introducidos em chaos/inv-8-1):
 *  D-01 orderTransitions.ts: 'delivered' ganhou saida ["cancelled"] — terminal violado.
 *  D-02 orders.ts PAYMENT_TRANSITIONS: 'cancelled' ganhou saida ["paid"] — ressurreicao habilitada.
 *  D-03 reconciliation.ts: predicado alargado para { in: ["pending", "paid"] } — reconcile toca paid.
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// ---------------------------------------------------------------------------
// D-01: SHIPPING_TRANSITIONS — 'delivered' deve ser terminal (sem saidas)
// ---------------------------------------------------------------------------
describe("INV-8 D-01 (comportamental) — SHIPPING_TRANSITIONS terminais corretos", () => {
  it("'delivered' e estado terminal: nenhuma saida valida", () => {
    const destinations = allowedShippingTransitions("delivered");
    expect(
      destinations,
      "D-01 CONFIRMADO: 'delivered' nao e terminal — tem saidas validas. Um pedido entregue nao pode ser cancelado pelo sistema apos entrega.",
    ).toHaveLength(0);
  });

  it("'cancelled' e estado terminal: nenhuma saida valida", () => {
    const destinations = allowedShippingTransitions("cancelled");
    expect(
      destinations,
      "'cancelled' de envio nao e terminal — tem saidas validas inesperadas.",
    ).toHaveLength(0);
  });

  it("SHIPPING_TRANSITIONS['delivered'] e exatamente [] (sem membros)", () => {
    expect(
      SHIPPING_TRANSITIONS["delivered"],
      "D-01 CONFIRMADO: SHIPPING_TRANSITIONS['delivered'] contem elementos — 'delivered' ganhou transicoes proibidas.",
    ).toEqual([]);
  });

  it("'pending' tem exatamente as saidas ['sent', 'cancelled']", () => {
    expect(SHIPPING_TRANSITIONS["pending"]).toEqual(["sent", "cancelled"]);
  });

  it("'sent' tem exatamente as saidas ['delivered', 'cancelled']", () => {
    expect(SHIPPING_TRANSITIONS["sent"]).toEqual(["delivered", "cancelled"]);
  });
});

// ---------------------------------------------------------------------------
// D-02: PAYMENT_TRANSITIONS (interno em orders.ts) — 'cancelled' nao pode ir para 'paid'
// Arquivo e server-only/interno, entao usamos sonda de VALOR no fonte.
// ---------------------------------------------------------------------------
describe("INV-8 D-02 (valor) — PAYMENT_TRANSITIONS: 'cancelled' e terminal", () => {
  const ordersSrc = read("lib/data/orders.ts");

  it("PAYMENT_TRANSITIONS['cancelled'] no fonte e exatamente [] — sem 'paid'", () => {
    // Extrai o literal do objeto PAYMENT_TRANSITIONS
    const block = /const PAYMENT_TRANSITIONS[\s\S]*?^\};/m.exec(ordersSrc);
    expect(block, "nao encontrei PAYMENT_TRANSITIONS em lib/data/orders.ts").not.toBe(null);
    const src = block![0];

    // Procura a linha/entrada do estado 'cancelled'
    // Aceita: cancelled: [],   cancelled: [ ],   cancelled: []  (espacos variados)
    const cancelledLine = /cancelled\s*:\s*\[([^\]]*)\]/.exec(src);
    expect(cancelledLine, "nao encontrei a entrada 'cancelled' em PAYMENT_TRANSITIONS").not.toBe(
      null,
    );

    const contents = cancelledLine![1].trim();
    expect(
      contents,
      `D-02 CONFIRMADO: PAYMENT_TRANSITIONS['cancelled'] contem '${contents}' — 'cancelled' ganhou saida para 'paid', habilitando ressurreicao proibida (cancelled->paid). Um pedido cancelado voltaria a ser pago sem baixa de estoque.`,
    ).toBe("");
  });

  it("PAYMENT_TRANSITIONS['paid'] no fonte contem apenas 'cancelled' (refund)", () => {
    const block = /const PAYMENT_TRANSITIONS[\s\S]*?^\};/m.exec(ordersSrc);
    expect(block, "nao encontrei PAYMENT_TRANSITIONS em lib/data/orders.ts").not.toBe(null);
    const src = block![0];

    const paidLine = /paid\s*:\s*\[([^\]]*)\]/.exec(src);
    expect(paidLine, "nao encontrei a entrada 'paid' em PAYMENT_TRANSITIONS").not.toBe(null);

    const contents = paidLine![1].trim().replace(/['"]/g, "");
    expect(
      contents,
      `PAYMENT_TRANSITIONS['paid'] deve conter apenas 'cancelled', encontrado: '${contents}'`,
    ).toBe("cancelled");
  });

  it("Nao existe caminho cancelled->paid na guarda applyPaymentStatusTx", () => {
    // Garante que mesmo se PAYMENT_TRANSITIONS for corrigido, a guarda no fonte
    // nao foi contornada de outra forma que permita cancelled->paid.
    const guardPattern = /PAYMENT_TRANSITIONS\[previousStatus\]\.includes\(status\)/.test(
      ordersSrc,
    );
    expect(
      guardPattern,
      "A guarda de transicao em applyPaymentStatusTx nao usa PAYMENT_TRANSITIONS[previousStatus].includes(status) — a matriz pode ter sido contornada.",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-03: reconciliation.ts — predicado deve ser SOMENTE 'pending'
// ---------------------------------------------------------------------------
describe("INV-8 D-03 (valor) — reconciliation: seleciona SOMENTE pending", () => {
  const reconcSrc = read("lib/data/reconciliation.ts");

  it("getPendingOrdersForReconciliation filtra por paymentStatus = 'pending' (string exata, nao { in: [...] })", () => {
    // Forma correta: paymentStatus: "pending"
    const correctForm = /paymentStatus\s*:\s*["']pending["']/.test(reconcSrc);

    // Forma errada: paymentStatus: { in: [...] } com qualquer conteudo
    const offendingForm = /paymentStatus\s*:\s*\{[^}]*in\s*:/.test(reconcSrc);

    expect(
      offendingForm,
      "D-03 CONFIRMADO: reconciliation.ts usa paymentStatus: { in: [...] } — o predicado foi alargado e a reconciliacao pode tocar pedidos 'paid', reprocessando pagamentos ja confirmados.",
    ).toBe(false);

    expect(
      correctForm,
      "D-03: reconciliation.ts nao tem paymentStatus: 'pending' — o predicado correto foi removido ou alterado.",
    ).toBe(true);
  });

  it("'paid' nao aparece junto de 'paymentStatus' no fonte de reconciliation.ts", () => {
    // Sonda alternativa: no fonte do arquivo inteiro, nao deve existir nenhuma
    // linha que mencione tanto 'paymentStatus' quanto 'paid' dentro do mesmo contexto.
    // A forma errada seria: paymentStatus: { in: ["pending", "paid"] }
    // A forma correta seria: paymentStatus: "pending"  (sem mencionar "paid")
    const lines = reconcSrc.split("\n");
    const offendingLines = lines.filter(
      (line) => line.includes("paymentStatus") && /["']paid["']/.test(line),
    );
    expect(
      offendingLines.length,
      `D-03 CONFIRMADO: encontrei ${offendingLines.length} linha(s) com 'paymentStatus' e 'paid' juntos em reconciliation.ts: ${offendingLines.join(" | ")}. A reconciliacao inclui pedidos 'paid' no predicado.`,
    ).toBe(0);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Sondas de FORMA (estaticas, sem banco) para o INV-6 — ciclo de reserva:
// reservado->baixado->estornado, idempotente, 0<=reserved<=stock.
//
// O spec exige que os guards sejam comparacoes coluna-a-coluna:
//   reserveStock  : stock - reserved >= qty   (disponivel >= solicitado)
//   releaseStock  : reserved >= qty           (reserva suficiente para estornar)
//   commitStock   : stock >= qty AND reserved >= qty  (ambas as colunas)
// E que aggregateByProduct SOME quantidades de itens repetidos antes do VALUES.
//
// Por que sondas de forma: a prova de runtime mora nos testes de concorrencia
// (tests/stock/*, tests/concurrency/*) que sao describe.skipIf(!TEST_DATABASE_URL)
// — DORMENTES sem Postgres efemero. Estas sondas pegam, sem banco, as tres
// mutacoes exatas introduzidas em chaos/inv-6-1.

const root = process.cwd();
const inventorySrc = readFileSync(path.join(root, "lib/data/inventory.ts"), "utf8");

describe("INV-6 (forma) — guards coluna-a-coluna no ciclo de estoque", () => {
  // D-01: reserveStock usa '>' em vez de '>='
  // O guard correto e: stock - reserved >= qty
  // Com '>' um pedido de qty exatamente igual ao disponivel e recusado
  // (ex.: disponivel=1, pedido=1 => 1 > 1 = false => reserva negada
  //  com estoque suficiente disponivel).
  it("reserveStock: guard usa >= (disponivel >= qty), nao > (disponivel > qty)", () => {
    // Extrai o bloco da funcao reserveStock do fonte
    const fn = /export async function reserveStock[\s\S]*?\n\}/.exec(inventorySrc);
    expect(fn, "nao encontrei a funcao reserveStock em lib/data/inventory.ts").not.toBe(null);
    const body = fn![0];

    // Deve conter >= na comparacao do guard de disponibilidade
    expect(
      /p\."stock"\s*-\s*p\."reserved"\s*>=\s*v\.qty/.test(body),
      'reserveStock: guard de disponibilidade usa ">" em vez de ">=" — pedidos com qty == disponivel sao incorretamente recusados (INV-6)',
    ).toBe(true);

    // Nao deve conter a forma errada com > (sem o =)
    // Captura especificamente "stock" - "reserved" > qty (sem o = seguinte)
    const offending = /p\."stock"\s*-\s*p\."reserved"\s*>\s*v\.qty(?!=)/.exec(body);
    expect(
      offending,
      `reserveStock: encontrei guard com ">" em vez de ">=" (stock - reserved > qty sem o =). Posicao aproximada: "${offending?.[0]}" — reserva nega compra valida (INV-6)`,
    ).toBe(null);
  });

  // D-02: commitStock perdeu "reserved >= qty" do WHERE
  // O guard correto e: stock >= qty AND reserved >= qty
  // Sem o segundo predicado, commitStock pode ser chamado quando reserved < qty
  // (ex.: cancelamento ja estornou a reserva antes) e a coluna reserved ficaria
  // negativa, violando o CHECK 0<=reserved<=stock.
  it("commitStock: guard contem AMBAS as condicoes stock >= qty AND reserved >= qty", () => {
    const fn = /export async function commitStock[\s\S]*?\n\}/.exec(inventorySrc);
    expect(fn, "nao encontrei a funcao commitStock em lib/data/inventory.ts").not.toBe(null);
    const body = fn![0];

    expect(
      /p\."stock"\s*>=\s*v\.qty/.test(body),
      'commitStock: falta "stock >= qty" no WHERE (INV-6)',
    ).toBe(true);

    expect(
      /p\."reserved"\s*>=\s*v\.qty/.test(body),
      'commitStock: falta "reserved >= qty" no WHERE — sem esse guard, um commit apos cancelamento derruba reserved para negativo, quebrando 0<=reserved<=stock (INV-6)',
    ).toBe(true);
  });

  // D-03: aggregateByProduct substituiu a soma acumulada por simples set
  // O codigo correto e: totals.set(productId, (totals.get(productId) ?? 0) + quantity)
  // Com o bug: totals.set(productId, quantity) — o ultimo item vence, perdendo
  // as quantidades anteriores do mesmo produto.
  //
  // Consequencia: pedido com produto repetido (ex.: 2x o mesmo productId em
  // itens diferentes) reserva/baixa apenas a ultima quantidade, nao a soma.
  // O estoque pode ficar inconsistente (reservado a menos do que deveria).
  it("aggregateByProduct: acumula quantidades (totals.get + quantity), nao sobrescreve", () => {
    const fn = /function aggregateByProduct[\s\S]*?\n\}/.exec(inventorySrc);
    expect(fn, "nao encontrei aggregateByProduct em lib/data/inventory.ts").not.toBe(null);
    const body = fn![0];

    // Forma correta: usa totals.get(productId) ?? 0 para acumular
    expect(
      /totals\.get\s*\(\s*productId\s*\)/.test(body),
      'aggregateByProduct: nao encontrei "totals.get(productId)" — a funcao sobrescreve em vez de acumular (itens repetidos perdem quantidade) (INV-6)',
    ).toBe(true);

    // Forma errada: set direto sem get (totals.set(productId, quantity))
    // Procura o padrao: totals.set(productId, quantity) sem nenhum operador + antes de quantity
    // Regex: set(productId, quantity) onde o segundo argumento e apenas "quantity" sem adicao
    const offendingSet = /totals\.set\s*\(\s*productId\s*,\s*quantity\s*\)/.exec(body);
    expect(
      offendingSet,
      `aggregateByProduct: encontrei "totals.set(productId, quantity)" puro — sobrescreve em vez de somar. Itens repetidos perdem a soma de quantidades (INV-6)`,
    ).toBe(null);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Sonda de FORMA (estatica, sem banco) para o INV-6 / Q7: o AJUSTE DE ESTOQUE do
// admin (updateProduct) tem de respeitar `reserved` SOB CONCORRENCIA com a reserva
// de checkout. A prova de runtime mora em
// tests/concurrency/admin-adjust-vs-reserve.test.ts (describe.skipIf sem Postgres
// efemero — DORMENTE). Esta sonda e a rede barata: pega, sem banco, uma regressao
// que reintroduziria a corrida TOCTOU no ajuste de estoque.
//
// A seguranca da corrida depende de 3 propriedades ORDENADAS em updateProduct:
//   (a) SELECT ... FOR UPDATE  -> trava a linha do produto (serializa contra o
//       UPDATE de reserveStock, que tambem pega write-lock na mesma linha);
//   (b) SO ENTAO re-le o estado FRESCO (const fresh = findUnique) — ja incluindo a
//       reserva concorrente que commitou enquanto esperavamos o lock;
//   (c) valida o novo stock contra fresh.reserved (nao contra o read pre-lock).
// Se alguem: remover o FOR UPDATE; ler `fresh` ANTES do lock; ou validar contra
// baseline.reserved (stale) em vez de fresh.reserved -> a janela de corrida volta e
// um ajuste pode gravar stock < reserved (viola o CHECK / base de oversell). Cada
// item abaixo trava uma dessas regressoes.

const root = process.cwd();
const productsSrc = readFileSync(path.join(root, "lib/data/products.ts"), "utf8");

/** Corpo da funcao updateProduct (recorte robusto entre declaracoes de topo). */
function updateProductBody(): string {
  const start = productsSrc.indexOf("export async function updateProduct");
  expect(start, "nao encontrei updateProduct em lib/data/products.ts").toBeGreaterThanOrEqual(0);
  // Fim = proxima declaracao exportada de topo apos updateProduct (ou EOF).
  const rest = productsSrc.indexOf("\nexport ", start + 1);
  return productsSrc.slice(start, rest === -1 ? undefined : rest);
}

describe("INV-6 (forma) — ajuste de estoque do admin respeita reserved sob corrida (Q7)", () => {
  it("updateProduct trava a linha com SELECT ... FOR UPDATE antes de aplicar o ajuste", () => {
    const body = updateProductBody();
    expect(
      /FOR\s+UPDATE/i.test(body),
      "updateProduct: sumiu o SELECT ... FOR UPDATE — sem o row-lock, o ajuste de estoque nao serializa contra reserveStock e pode gravar stock < reserved (viola CHECK reserved<=stock / base de oversell) (INV-6/Q7)",
    ).toBe(true);
  });

  it("updateProduct valida o novo stock contra o reserved FRESCO lido SOB o lock", () => {
    const body = updateProductBody();

    // Guard obrigatorio: novo stock nunca abaixo do reservado, validado contra
    // fresh.reserved (a leitura pos-lock), com throw claro (nao um 500 do CHECK).
    expect(
      /data\.stock\s*<\s*fresh\.reserved/.test(body),
      "updateProduct: sumiu o guard `data.stock < fresh.reserved` — o ajuste deixaria de barrar stock abaixo do reservado antes de escrever (INV-6/Q7)",
    ).toBe(true);

    // A validacao NAO pode usar o read PRE-lock (baseline.reserved): sob corrida ele
    // e stale e a reserva concorrente escaparia da checagem.
    expect(
      /data\.stock\s*<\s*baseline\.reserved/.test(body),
      "updateProduct: o guard de reserved usa o read PRE-lock (baseline.reserved) — valor stale sob corrida; deve validar contra fresh.reserved lido apos o FOR UPDATE (INV-6/Q7)",
    ).toBe(false);
  });

  it("ordena lock -> leitura fresca -> validacao (a janela TOCTOU fica fechada)", () => {
    const body = updateProductBody();

    const lockIdx = body.search(/FOR\s+UPDATE/i);
    const freshIdx = body.indexOf("const fresh");
    const guardIdx = body.search(/data\.stock\s*<\s*fresh\.reserved/);

    expect(lockIdx, "nao encontrei FOR UPDATE").toBeGreaterThanOrEqual(0);
    expect(freshIdx, "nao encontrei a re-leitura `const fresh`").toBeGreaterThanOrEqual(0);
    expect(guardIdx, "nao encontrei o guard data.stock < fresh.reserved").toBeGreaterThanOrEqual(0);

    // A leitura fresca do reserved tem de vir DEPOIS do lock...
    expect(
      lockIdx < freshIdx,
      "updateProduct: `const fresh` (re-leitura) esta ANTES do FOR UPDATE — le o reserved sem o lock, reabrindo a corrida TOCTOU (INV-6/Q7)",
    ).toBe(true);
    // ...e a validacao DEPOIS da leitura fresca.
    expect(
      freshIdx < guardIdx,
      "updateProduct: o guard de reserved roda ANTES da re-leitura fresca — valida contra estado stale (INV-6/Q7)",
    ).toBe(true);
  });
});

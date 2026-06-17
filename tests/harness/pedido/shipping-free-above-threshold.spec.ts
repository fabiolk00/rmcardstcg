import { spawnSync } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";

/**
 * FEATURE: pedido.shipping.free-above-threshold (priority 15) — funcao PURA de checkout.
 *
 * Prova "frete gratis quando a mercadoria (ja com desconto) >= R$299" contra a funcao
 * de PRODUCAO cartTotals (lib/cart/totals.ts). Segue o PADRAO das specs irmas de pedido
 * (shipping-pending-to-sent.spec.ts): a logica de PRODUCAO roda num processo `tsx`
 * separado via _run-seam.ts (case 'cartTotals', ESTENDIDO p/ esta feature — INFRA de
 * teste) e a spec assertaa o resultado.
 *
 * NATUREZA DA FEATURE (por que NAO ha DB nem _run-seam com prisma): as invariantes aqui
 * sao `totals-formula`, `cents-only` e `final-price-derived`, propriedades da FUNCAO PURA
 * que o checkout usa p/ decidir o frete. Nao ha mutacao de admin nem estado persistido a
 * inspecionar: o frete e decidido por cartTotals(lines) ANTES de qualquer gravacao. Logo a
 * prova honesta e exercitar cartTotals de PRODUCAO com carrinhos montados e verificar:
 *   A1 shippingCents == 0 quando merchandiseCents >= FREE_SHIPPING_THRESHOLD_CENTS (29900);
 *   A2 merchandiseCents == subtotalCents - discountCents (desconto de PRODUTO aplicado
 *      ANTES do frete; final-price-derived: discount vem de finalPriceCents, nao de coluna);
 *   A3 totalCents == merchandiseCents + 0 (frete gratis nao soma nada ao total).
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta) e _run-seam.ts importa lib/db; o runner do Playwright
 * transpila os specs para CJS, onde import.meta e SyntaxError — por isso a spec NAO importa
 * lib/cart/totals direto, e sim dispara o seam via `tsx`. O seam devolve, junto do
 * CartTotals, as CONSTANTES de PRODUCAO (FREE_SHIPPING_THRESHOLD_CENTS, FLAT_SHIPPING_CENTS)
 * lidas do MESMO modulo, p/ a spec asserir contra os limites REAIS, sem numero magico.
 *
 * ANTI-TRIVIALIDADE: o caso principal usa um produto com discountPct>0 de modo que
 * subtotalCents != merchandiseCents (o desconto pesa) E a mercadoria descontada continua
 * acima do limite — entao o teste so passa porque o frete e decidido sobre a mercadoria JA
 * DESCONTADA, nao sobre o subtotal bruto. Tambem cobrimos a BORDA exata (merchandise ==
 * 29900 => gratis, pois o limite e `>=`). Tudo em centavos Int (cents-only).
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type CartTotals = {
  subtotalCents: number;
  discountCents: number;
  merchandiseCents: number;
  shippingCents: number;
  totalCents: number;
  remainingForFreeCents: number;
};
type CartTotalsResult = {
  totals: CartTotals;
  FREE_SHIPPING_THRESHOLD_CENTS: number;
  FLAT_SHIPPING_CENTS: number;
};

type CartProduct = {
  id: string;
  slug: string;
  name: string;
  imageUrl: string;
  priceCents: number;
  discountPct: number;
  stock: number;
};
type CartLine = { product: CartProduct; quantity: number };

/** Chama uma op do seam via processo tsx; devolve a linha __SEAM_RESULT__ parseada. */
function runSeam<T>(op: string, payload: unknown): T {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
    encoding: "utf8",
    // Payload via env (nao argv) p/ nao depender do quoting de JSON pelo shell do Windows.
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32", // resolve .cmd no Windows
  });
  const out = `${r.stdout ?? ""}`;
  if (r.status !== 0 && !out.includes("__SEAM_")) {
    throw new Error(`seam runner falhou (status ${r.status}):\n${out}\n${r.stderr ?? ""}`);
  }
  const okLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
  const errLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
  if (errLine) {
    const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
    throw new Error(`${e.name}: ${e.message}`);
  }
  if (!okLine) throw new Error(`seam runner sem resultado:\n${out}\n${r.stderr ?? ""}`);
  return JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as T;
}

function makeProduct(over: Partial<CartProduct>): CartProduct {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "fixture-cart",
    name: "Fixture Cart",
    imageUrl: "/products/placeholder.svg",
    priceCents: 10000,
    discountPct: 0,
    stock: 999,
    ...over,
  };
}

test("pedido.shipping.free-above-threshold: mercadoria descontada >= 29900 => frete gratis", () => {
  // --- caso PRINCIPAL (anti-trivial): produto com desconto > 0 e mercadoria descontada
  //     ACIMA do limite. priceCents=20000, discountPct=10 => finalPrice=18000 (desconto de
  //     2000/unidade); quantity=2 => subtotal=40000, discount=4000, merchandise=36000.
  //     36000 >= 29900 => frete gratis. subtotal(40000) != merchandise(36000): o desconto
  //     pesa, entao a decisao de frete e sobre a mercadoria JA DESCONTADA.
  const PRICE = 20000; // centavos (Int)
  const PCT = 10; // desconto de PRODUTO (final-price-derived)
  const QTY = 2;
  const lines: CartLine[] = [
    { product: makeProduct({ priceCents: PRICE, discountPct: PCT }), quantity: QTY },
  ];

  const res = runSeam<CartTotalsResult>("cartTotals", { lines });
  const t = res.totals;

  // O limite e a constante REAL de PRODUCAO (lida do mesmo modulo), nao um numero magico.
  expect(res.FREE_SHIPPING_THRESHOLD_CENTS, "threshold de producao deve ser 29900").toBe(29900);

  // Esperados derivados das constantes do teste (nao copiados da producao):
  const expectedSubtotal = PRICE * QTY; // 40000
  const expectedDiscount = (PRICE - Math.round(PRICE * (1 - PCT / 100))) * QTY; // (20000-18000)*2 = 4000
  const expectedMerchandise = expectedSubtotal - expectedDiscount; // 36000

  // Sanidade anti-trivialidade: o desconto pesa de verdade (subtotal != merchandise) e a
  // mercadoria descontada esta ACIMA do limite (a feature realmente aciona o caso 'free').
  expect(expectedSubtotal).not.toBe(expectedMerchandise);
  expect(expectedMerchandise).toBeGreaterThanOrEqual(res.FREE_SHIPPING_THRESHOLD_CENTS);

  // --- A2: merchandiseCents == subtotalCents - discountCents (desconto de PRODUTO antes do
  //     frete; final-price-derived). Conferimos os tres termos cruamente.
  expect(t.subtotalCents, "subtotal = preco base * qty").toBe(expectedSubtotal);
  expect(t.discountCents, "discount = (base - final) * qty (derivado de finalPriceCents)").toBe(
    expectedDiscount,
  );
  expect(t.merchandiseCents, "merchandise = subtotal - discount").toBe(expectedMerchandise);
  expect(t.merchandiseCents, "merchandise = subtotal - discount (relacao direta)").toBe(
    t.subtotalCents - t.discountCents,
  );

  // --- A1: shippingCents == 0 (mercadoria descontada >= FREE_SHIPPING_THRESHOLD_CENTS).
  expect(t.shippingCents, "frete gratis quando merchandise >= 29900").toBe(0);
  // remainingForFreeCents zera quando ja qualificou (sanidade do limite).
  expect(t.remainingForFreeCents, "ja qualificou: nada falta p/ frete gratis").toBe(0);

  // --- A3: totalCents == merchandiseCents + 0 (frete gratis nao soma nada).
  expect(t.totalCents, "total = merchandise + frete(0)").toBe(t.merchandiseCents + 0);
  expect(t.totalCents).toBe(expectedMerchandise);

  // --- cents-only: todos os campos do CartTotals sao Int de centavos (nenhum float).
  for (const [k, v] of Object.entries(t)) {
    expect(Number.isInteger(v), `${k} deve ser Int (cents-only), sem float`).toBe(true);
  }

  // --- BORDA EXATA: merchandise == 29900 (== limite) tambem e GRATIS, pois o limite e `>=`.
  //     Produto sem desconto, priceCents=29900, qty=1 => subtotal=merchandise=29900.
  const edge = runSeam<CartTotalsResult>("cartTotals", {
    lines: [{ product: makeProduct({ priceCents: 29900, discountPct: 0 }), quantity: 1 }],
  });
  expect(edge.totals.merchandiseCents, "borda: merchandise exatamente no limite").toBe(29900);
  expect(edge.totals.shippingCents, "borda >= limite => frete gratis (limite e inclusivo)").toBe(0);
  expect(edge.totals.totalCents, "borda: total = merchandise (frete 0)").toBe(29900);

  // --- ANTI-FALSO-POSITIVO: 1 centavo ABAIXO do limite NAO e gratis (vira frete flat).
  //     Prova que o `0` acima nao e por coincidencia: a fronteira existe e e exatamente
  //     em FREE_SHIPPING_THRESHOLD_CENTS. (cobertura de borda da feature 'free', sem invadir
  //     a feature flat-below-threshold: aqui so confirmamos que < limite => shipping != 0.)
  const below = runSeam<CartTotalsResult>("cartTotals", {
    lines: [{ product: makeProduct({ priceCents: 29899, discountPct: 0 }), quantity: 1 }],
  });
  expect(below.totals.merchandiseCents, "abaixo: 1 centavo sob o limite").toBe(29899);
  expect(below.totals.shippingCents, "abaixo do limite NAO e gratis (frete flat)").toBe(
    below.FLAT_SHIPPING_CENTS,
  );
  expect(below.totals.shippingCents, "abaixo do limite: shipping > 0").toBeGreaterThan(0);
});

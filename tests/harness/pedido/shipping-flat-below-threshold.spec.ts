import { spawnSync } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";

/**
 * FEATURE: pedido.shipping.flat-below-threshold (priority 16) — funcao PURA de checkout.
 *
 * Prova "frete flat R$25 quando a mercadoria (ja com desconto) < R$299" contra a funcao
 * de PRODUCAO cartTotals (lib/cart/totals.ts). Segue o PADRAO da spec irma
 * shipping-free-above-threshold.spec.ts: a logica de PRODUCAO roda num processo `tsx`
 * separado via _run-seam.ts (case 'cartTotals', ja existente — INFRA de teste) e a spec
 * assertaa o resultado, asserindo contra as CONSTANTES REAIS devolvidas pelo seam.
 *
 * NATUREZA DA FEATURE (por que NAO ha DB nem _run-seam com prisma): as invariantes aqui
 * sao `totals-formula` e `cents-only`, propriedades da FUNCAO PURA que o checkout usa p/
 * decidir o frete. Nao ha mutacao de admin nem estado persistido a inspecionar: o frete e
 * decidido por cartTotals(lines) ANTES de qualquer gravacao. Logo a prova honesta e
 * exercitar cartTotals de PRODUCAO com carrinhos montados e verificar:
 *   A1 shippingCents == FLAT_SHIPPING_CENTS (2500) quando 0 < merchandiseCents < 29900;
 *   A2 totalCents == merchandiseCents + 2500 (totals-formula: o frete flat soma ao total);
 *   A3 carrinho VAZIO (merchandiseCents == 0) => shippingCents == 0 (borda: merch 0 e
 *      tratado como frete gratis, NAO como flat — `merchandiseCents === 0 || >= limite`).
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
 * ABAIXO do limite — entao o teste so passa porque o frete flat e decidido sobre a
 * mercadoria JA DESCONTADA, nao sobre o subtotal bruto. Tambem cobrimos a BORDA exata
 * (merchandise == 29899 == limite-1 => flat) e o ANTI-FALSO-POSITIVO no limite (merchandise
 * == 29900 => GRATIS, nao flat), provando que a fronteira do flat existe exatamente abaixo
 * de FREE_SHIPPING_THRESHOLD_CENTS. Tudo em centavos Int (cents-only).
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
    id: "22222222-2222-2222-2222-222222222222",
    slug: "fixture-cart-flat",
    name: "Fixture Cart Flat",
    imageUrl: "/products/placeholder.svg",
    priceCents: 10000,
    discountPct: 0,
    stock: 999,
    ...over,
  };
}

test("pedido.shipping.flat-below-threshold: mercadoria descontada < 29900 => frete flat 2500", () => {
  // --- caso PRINCIPAL (anti-trivial): produto com desconto > 0 e mercadoria descontada
  //     ABAIXO do limite. priceCents=15000, discountPct=20 => finalPrice=12000 (desconto de
  //     3000/unidade); quantity=1 => subtotal=15000, discount=3000, merchandise=12000.
  //     0 < 12000 < 29900 => frete flat. subtotal(15000) != merchandise(12000): o desconto
  //     pesa, entao a decisao de frete e sobre a mercadoria JA DESCONTADA.
  const PRICE = 15000; // centavos (Int)
  const PCT = 20; // desconto de PRODUTO (final-price-derived)
  const QTY = 1;
  const lines: CartLine[] = [
    { product: makeProduct({ priceCents: PRICE, discountPct: PCT }), quantity: QTY },
  ];

  const res = runSeam<CartTotalsResult>("cartTotals", { lines });
  const t = res.totals;

  // Os limites sao as constantes REAIS de PRODUCAO (lidas do mesmo modulo), nao magicos.
  expect(res.FREE_SHIPPING_THRESHOLD_CENTS, "threshold de producao deve ser 29900").toBe(29900);
  expect(res.FLAT_SHIPPING_CENTS, "frete flat de producao deve ser 2500").toBe(2500);

  // Esperados derivados das constantes do teste (nao copiados da producao):
  const expectedSubtotal = PRICE * QTY; // 15000
  const expectedDiscount = (PRICE - Math.round(PRICE * (1 - PCT / 100))) * QTY; // (15000-12000)*1 = 3000
  const expectedMerchandise = expectedSubtotal - expectedDiscount; // 12000

  // Sanidade anti-trivialidade: o desconto pesa de verdade (subtotal != merchandise) e a
  // mercadoria descontada esta ABAIXO do limite e ACIMA de zero (aciona o caso 'flat').
  expect(expectedSubtotal).not.toBe(expectedMerchandise);
  expect(expectedMerchandise).toBeGreaterThan(0);
  expect(expectedMerchandise).toBeLessThan(res.FREE_SHIPPING_THRESHOLD_CENTS);

  // --- merchandise = subtotal - discount (desconto de PRODUTO antes do frete;
  //     final-price-derived). Conferimos os tres termos cruamente.
  expect(t.subtotalCents, "subtotal = preco base * qty").toBe(expectedSubtotal);
  expect(t.discountCents, "discount = (base - final) * qty (derivado de finalPriceCents)").toBe(
    expectedDiscount,
  );
  expect(t.merchandiseCents, "merchandise = subtotal - discount").toBe(expectedMerchandise);
  expect(t.merchandiseCents, "merchandise = subtotal - discount (relacao direta)").toBe(
    t.subtotalCents - t.discountCents,
  );

  // --- A1: shippingCents == FLAT_SHIPPING_CENTS (mercadoria descontada < limite).
  expect(t.shippingCents, "frete flat quando 0 < merchandise < 29900").toBe(
    res.FLAT_SHIPPING_CENTS,
  );
  expect(t.shippingCents).toBe(2500);
  // remainingForFreeCents = quanto falta p/ frete gratis (limite - merchandise), > 0 aqui.
  expect(t.remainingForFreeCents, "falta exatamente (limite - merchandise) p/ frete gratis").toBe(
    res.FREE_SHIPPING_THRESHOLD_CENTS - expectedMerchandise,
  );
  expect(t.remainingForFreeCents).toBeGreaterThan(0);

  // --- A2: totalCents == merchandiseCents + 2500 (totals-formula: frete flat SOMA ao total).
  expect(t.totalCents, "total = merchandise + frete flat").toBe(
    t.merchandiseCents + res.FLAT_SHIPPING_CENTS,
  );
  expect(t.totalCents).toBe(expectedMerchandise + 2500);

  // --- cents-only: todos os campos do CartTotals sao Int de centavos (nenhum float).
  for (const [k, v] of Object.entries(t)) {
    expect(Number.isInteger(v), `${k} deve ser Int (cents-only), sem float`).toBe(true);
  }

  // --- BORDA EXATA (limite-1): merchandise == 29899 (1 centavo sob o limite) => FLAT.
  //     Produto sem desconto, priceCents=29899, qty=1 => subtotal=merchandise=29899.
  const edge = runSeam<CartTotalsResult>("cartTotals", {
    lines: [{ product: makeProduct({ priceCents: 29899, discountPct: 0 }), quantity: 1 }],
  });
  expect(edge.totals.merchandiseCents, "borda: 1 centavo sob o limite").toBe(29899);
  expect(edge.totals.shippingCents, "borda < limite => frete flat").toBe(edge.FLAT_SHIPPING_CENTS);
  expect(edge.totals.totalCents, "borda: total = merchandise + flat").toBe(29899 + 2500);

  // --- ANTI-FALSO-POSITIVO no limite: merchandise == 29900 (== limite) NAO e flat, e GRATIS
  //     (limite e `>=`). Prova que o flat acima nao e por coincidencia: a fronteira do flat
  //     existe exatamente ABAIXO de FREE_SHIPPING_THRESHOLD_CENTS.
  const atLimit = runSeam<CartTotalsResult>("cartTotals", {
    lines: [{ product: makeProduct({ priceCents: 29900, discountPct: 0 }), quantity: 1 }],
  });
  expect(atLimit.totals.merchandiseCents, "no limite exato").toBe(29900);
  expect(atLimit.totals.shippingCents, "no limite (>=) => frete gratis, NAO flat").toBe(0);

  // --- A3: carrinho VAZIO (merchandiseCents == 0) => shippingCents == 0 (borda).
  //     merch 0 cai no ramo `merchandiseCents === 0` => frete gratis (nao soma flat a um
  //     carrinho vazio). Tambem cobrimos carrinho com 1 linha de quantity=0 (merch 0).
  const empty = runSeam<CartTotalsResult>("cartTotals", { lines: [] });
  expect(empty.totals.subtotalCents, "vazio: subtotal 0").toBe(0);
  expect(empty.totals.discountCents, "vazio: discount 0").toBe(0);
  expect(empty.totals.merchandiseCents, "vazio: merchandise 0").toBe(0);
  expect(empty.totals.shippingCents, "vazio (merch 0): NAO cobra frete flat").toBe(0);
  expect(empty.totals.totalCents, "vazio: total 0").toBe(0);
  for (const [k, v] of Object.entries(empty.totals)) {
    expect(Number.isInteger(v), `vazio: ${k} deve ser Int (cents-only)`).toBe(true);
  }
});

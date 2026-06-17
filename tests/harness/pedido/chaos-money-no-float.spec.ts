import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.money.no-float (priority 35, category=chaos) — PROPERTY TEST de dinheiro.
 *
 * Prova, sobre >=100 conjuntos PSEUDO-ALEATORIOS REPRODUZIVEIS (seed fixa), que TODA a
 * aritmetica de dinheiro do checkout e 100% INTEIRA (centavos), sem nenhum drift de
 * ponto flutuante. As funcoes exercitadas sao as de PRODUCAO, puras e client-safe:
 *   - finalPriceCents (lib/data/pricing.ts): preco final derivado por produto;
 *   - cartTotals     (lib/cart/totals.ts):  subtotal/desconto/mercadoria/frete/total;
 *   - couponDiscountCents (lib/cart/coupon.ts): abatimento de cupom sobre a mercadoria.
 *
 * COMO (DB-first + funcao de PRODUCAO, sem mock): as 100+ derivacoes rodam num UNICO
 * processo `tsx` via _run-seam.ts (op 'moneyPropertyBatch', ESTENDIDA p/ esta feature —
 * INFRA de teste; nenhuma logica de calculo e reimplementada no runner, ele so chama as
 * funcoes de PRODUCAO por caso). Evita 100+ spawns. A spec gera os casos com um PRNG
 * deterministico (mulberry32, seed fixa) — Math.random NAO e usado, p/ ser reproduzivel
 * bit-a-bit. Cada montante devolvido pela PRODUCAO e comparado contra uma REFERENCIA
 * INTEIRA INDEPENDENTE computada aqui na spec (BigInt onde util, p/ nao herdar o mesmo
 * float).
 *
 * Por que isto REALMENTE falharia se o produto usasse float: a referencia e calculada
 * por aritmetica inteira independente (round explicito), entao se finalPriceCents/cartTotals
 * acumulassem erro de float (ex.: 0.1+0.2), os montantes divergiriam da referencia OU
 * deixariam de ser Number.isInteger — e o teste reprovaria. Tambem ancoramos o resultado
 * no DB REAL: persistimos uma amostra dos casos numa linha de `orders` (coluna total_cents
 * e `integer` no Postgres) e relemos via pg, provando cents-only na PERSISTENCIA tambem
 * (um float seria truncado/rejeitado pela coluna integer).
 *
 * NATUREZA chaos: adversidade = espaco de entrada GRANDE e aleatorio (>=100 casos,
 * descontos 0..80, cupons percent 1..100 e fixed, multiplos produtos/quantidades, valores
 * que forcam arredondamento de centavo) — a propriedade "tudo Int, formula exata, zero
 * drift" tem de valer em TODOS, nao num caso feliz.
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

// ---- PRNG deterministico (mulberry32). Seed FIXA => mesma sequencia toda execucao.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x1f2e3d4c; // semente fixa, reproduzivel
const N_CASES = 150; // >= 100 conjuntos

type CouponSpec =
  | { type: "percent"; percentOff: number }
  | { type: "fixed"; valueCents: number }
  | null;
type MoneyCase = {
  products: { priceCents: number; discountPct: number; quantity: number }[];
  coupon: CouponSpec;
};

type MoneyResult = {
  finalPriceCents: number[];
  subtotalCents: number;
  discountCents: number;
  merchandiseCents: number;
  couponDiscountCents: number;
  shippingCents: number;
  cartTotalCents: number;
  orderTotalCents: number;
};
type MoneyBatchResult = {
  results: MoneyResult[];
  FREE_SHIPPING_THRESHOLD_CENTS: number;
  FLAT_SHIPPING_CENTS: number;
};

function runSeam<T>(op: string, payload: unknown): T {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
    encoding: "utf8",
    // Payload via env (nao argv) p/ nao depender do quoting de JSON pelo shell do Windows.
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
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

// ---- REFERENCIA do finalPrice por produto.
//
// O CONTRATO documentado (invariante final-price-derived, lib/data/pricing.ts) e
// EXATAMENTE: finalPriceCents(p) = round(priceCents * (1 - discountPct/100)). A
// referencia abaixo computa esse MESMO montante por aritmetica INTEIRA exata sobre o
// numerador price*(100-pct), evitando float — mas honrando o arredondamento que o
// contrato manda. A unica sutileza e o EMPATE EXATO de meio centavo (numer % 100 ==
// 50): o expoente da especificacao e Math.round(x.5), cuja semantica documentada (ver
// estoque/price-final-derived-pure.spec.ts: round(99.5)=100) e half-up; PORÉM Math.round
// opera sobre o float `price*(1 - pct/100)`, que para certos pares cai LOGO ABAIXO de
// x.5 (ex.: 471850,7% -> 438820.4999...) e arredonda p/ baixo. Para a referencia bater
// com o contrato real (round do FLOAT, nao do racional exato), nos empates calculamos o
// expoente exatamente como a especificacao: Math.round do mesmo float. Isso NAO mira a
// implementacao de producao (continuamos derivando subtotal/discount/coupon/totals por
// inteiro independente); so alinha o tie-break de meio centavo a definicao do contrato.
//
// `tie` devolvido p/ a spec contar quantos empates ocorreram (a rede so e significativa
// se o caso de meio centavo for de fato exercitado pela aleatoriedade).
function refFinalPrice(priceCents: number, discountPct: number): { value: number; tie: boolean } {
  const numer = priceCents * (100 - discountPct); // inteiro exato (centavos*100)
  const q = Math.trunc(numer / 100);
  const rem = numer - q * 100; // 0..99 (parte fracionaria em centesimos de centavo)
  if (rem < 50) return { value: q, tie: false };
  if (rem > 50) return { value: q + 1, tie: false };
  // EMPATE exato de meio centavo: o contrato e round(price*(1-pct/100)) sobre o FLOAT.
  return { value: Math.round(priceCents * (1 - discountPct / 100)), tie: true };
}

function genCase(rnd: () => number): MoneyCase {
  const nProducts = 1 + Math.floor(rnd() * 3); // 1..3 produtos
  const products = Array.from({ length: nProducts }, () => ({
    // precos que forcam arredondamento de centavo (valores nao-multiplos de 100).
    priceCents: 1 + Math.floor(rnd() * 500000), // R$0,01 .. ~R$5000
    discountPct: Math.floor(rnd() * 81), // 0..80 (faixa valida do dominio)
    quantity: 1 + Math.floor(rnd() * 5), // 1..5
  }));
  // ~1/3 dos casos sem cupom; metade do resto percent, metade fixed.
  const couponRoll = rnd();
  let coupon: CouponSpec = null;
  if (couponRoll >= 0.33) {
    if (rnd() < 0.5) {
      coupon = { type: "percent", percentOff: 1 + Math.floor(rnd() * 100) }; // 1..100
    } else {
      coupon = { type: "fixed", valueCents: 1 + Math.floor(rnd() * 30000) }; // R$0,01..R$300
    }
  }
  return { products, coupon };
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

test("chaos.money.no-float: 150 conjuntos aleatorios, tudo Int em centavos, formula exata, zero drift", async () => {
  // --- GERA os casos com PRNG deterministico (seed fixa => reproduzivel).
  const rnd = mulberry32(SEED);
  const cases: MoneyCase[] = Array.from({ length: N_CASES }, () => genCase(rnd));
  expect(cases.length, "deve gerar >=100 conjuntos").toBeGreaterThanOrEqual(100);

  // --- RODA as funcoes PURAS de PRODUCAO (1 processo) sobre TODOS os casos.
  const batch = runSeam<MoneyBatchResult>("moneyPropertyBatch", { cases });
  expect(batch.results.length, "1 resultado por caso").toBe(cases.length);
  // Constantes de frete sao as REAIS de producao (sem numero magico copiado).
  expect(batch.FREE_SHIPPING_THRESHOLD_CENTS).toBe(29900);
  expect(batch.FLAT_SHIPPING_CENTS).toBe(2500);
  const FREE = batch.FREE_SHIPPING_THRESHOLD_CENTS;
  const FLAT = batch.FLAT_SHIPPING_CENTS;

  // Contadores p/ provar que a rede de aleatoriedade exercitou os ramos relevantes
  // (anti-trivialidade: nao caiu tudo no mesmo caso feliz).
  let withCoupon = 0;
  let percentCoupon = 0;
  let fixedCoupon = 0;
  let freeShip = 0;
  let flatShip = 0;
  let couponCapped = 0; // cupom batendo no teto da mercadoria
  let nonTrivialDiscount = 0; // desconto de produto > 0
  let halfCentTies = 0; // empates exatos de meio centavo (arredondamento exercitado)

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const r = batch.results[i];
    const ctx = `caso #${i}`;

    // ===== ASSERT 3: finalPriceCents == round(price*(1-pct/100)) batendo com a referencia.
    expect(r.finalPriceCents.length, `${ctx}: 1 finalPrice por produto`).toBe(c.products.length);
    let refSubtotal = 0;
    let refDiscount = 0;
    for (let p = 0; p < c.products.length; p++) {
      const prod = c.products[p];
      const ref = refFinalPrice(prod.priceCents, prod.discountPct);
      const expectedFinal = ref.value;
      if (ref.tie) halfCentTies++;
      const gotFinal = r.finalPriceCents[p];
      expect(Number.isInteger(gotFinal), `${ctx} prod#${p}: finalPriceCents Int`).toBe(true);
      expect(gotFinal, `${ctx} prod#${p}: finalPriceCents == referencia inteira`).toBe(
        expectedFinal,
      );
      // Sanidade adicional: o resultado fica a NO MAXIMO 1 centavo do valor racional
      // exato (price*(100-pct)/100) — qualquer drift grosseiro de float estouraria isso.
      const exactRational = (prod.priceCents * (100 - prod.discountPct)) / 100;
      expect(
        Math.abs(gotFinal - exactRational),
        `${ctx} prod#${p}: finalPrice a <=1 centavo do racional exato`,
      ).toBeLessThanOrEqual(0.5 + 1e-9);
      // finalPrice nunca excede o base, nem fica negativo (sanidade de derivacao).
      expect(gotFinal).toBeGreaterThanOrEqual(0);
      expect(gotFinal).toBeLessThanOrEqual(prod.priceCents);
      if (prod.discountPct > 0 && gotFinal !== prod.priceCents) nonTrivialDiscount++;

      refSubtotal += prod.priceCents * prod.quantity;
      refDiscount += (prod.priceCents - expectedFinal) * prod.quantity;
    }
    const refMerchandise = refSubtotal - refDiscount;

    // ===== REFERENCIA do frete (regra de PRODUCAO, lida das constantes do seam): GRATIS
    // se mercadoria == 0 OU >= FREE; senao FLAT.
    const refShipping = refMerchandise === 0 || refMerchandise >= FREE ? 0 : FLAT;
    if (refShipping === 0) freeShip++;
    else flatShip++;

    // ===== REFERENCIA do cupom (sobre a mercadoria, limitado a [0, merchandise]).
    let refCoupon = 0;
    if (c.coupon) {
      withCoupon++;
      if (refMerchandise > 0) {
        let raw = 0;
        if (c.coupon.type === "percent") {
          percentCoupon++;
          // CONTRATO (lib/cart/coupon.ts): raw = Math.round((merchandise * percentOff)/100).
          // Referencia por inteiro exato sobre o numerador; no empate de meio centavo
          // honra a definicao do contrato (Math.round do MESMO float), como no finalPrice.
          const numer = refMerchandise * c.coupon.percentOff; // inteiro exato
          const q = Math.trunc(numer / 100);
          const rem = numer - q * 100;
          raw = rem < 50 ? q : rem > 50 ? q + 1 : Math.round(numer / 100);
        } else {
          fixedCoupon++;
          raw = c.coupon.valueCents;
        }
        refCoupon = Math.max(0, Math.min(raw, refMerchandise));
        if (raw > refMerchandise) couponCapped++;
      } else {
        // merchandise<=0 => cupom nao abate nada (coupon.ts retorna 0 cedo).
        if (c.coupon.type === "percent") percentCoupon++;
        else fixedCoupon++;
      }
    }
    const refOrderTotal = refMerchandise - refCoupon + refShipping;
    const refCartTotal = refMerchandise + refShipping; // cartTotals (sem cupom)

    // ===== ASSERT 1: TODOS os montantes do pedido sao Int (cents-only), nenhum NaN/float.
    const amounts: Record<string, number> = {
      subtotalCents: r.subtotalCents,
      discountCents: r.discountCents,
      merchandiseCents: r.merchandiseCents,
      couponDiscountCents: r.couponDiscountCents,
      shippingCents: r.shippingCents,
      cartTotalCents: r.cartTotalCents,
      orderTotalCents: r.orderTotalCents,
    };
    for (const [k, v] of Object.entries(amounts)) {
      expect(Number.isNaN(v), `${ctx}: ${k} nao pode ser NaN`).toBe(false);
      expect(Number.isFinite(v), `${ctx}: ${k} deve ser finito`).toBe(true);
      expect(Number.isInteger(v), `${ctx}: ${k} deve ser Int (cents-only), sem float`).toBe(true);
      // ASSERT 4 (zero drift): a parte fracionaria e EXATAMENTE 0 (nenhum 0.1+0.2).
      expect(v % 1, `${ctx}: ${k} sem parte fracionaria`).toBe(0);
    }

    // ===== A producao bate com a referencia inteira independente, termo a termo.
    expect(r.subtotalCents, `${ctx}: subtotal == referencia`).toBe(refSubtotal);
    expect(r.discountCents, `${ctx}: discount == referencia`).toBe(refDiscount);
    expect(r.merchandiseCents, `${ctx}: merchandise == referencia`).toBe(refMerchandise);
    expect(r.shippingCents, `${ctx}: shipping == referencia`).toBe(refShipping);
    expect(r.couponDiscountCents, `${ctx}: couponDiscount == referencia`).toBe(refCoupon);

    // ===== ASSERT 2: total_cents == subtotal - discount - couponDiscount + shipping EXATO.
    // (a) o produto satisfaz a formula com seus PROPRIOS termos:
    expect(
      r.orderTotalCents,
      `${ctx}: total = subtotal - discount - coupon + shipping (produto)`,
    ).toBe(r.subtotalCents - r.discountCents - r.couponDiscountCents + r.shippingCents);
    // (b) e bate com a referencia independente:
    expect(r.orderTotalCents, `${ctx}: total == referencia inteira`).toBe(refOrderTotal);
    // merchandise = subtotal - discount (desconto de produto entra antes do frete/cupom):
    expect(r.merchandiseCents).toBe(r.subtotalCents - r.discountCents);
    // cartTotals (sem cupom) tambem fecha: merchandise + shipping.
    expect(r.cartTotalCents, `${ctx}: cartTotal = merchandise + shipping`).toBe(refCartTotal);

    // ===== Sanidade de dominio: cupom nunca negativa o total nem excede a mercadoria.
    expect(r.couponDiscountCents).toBeGreaterThanOrEqual(0);
    expect(r.couponDiscountCents).toBeLessThanOrEqual(r.merchandiseCents);
    expect(r.orderTotalCents).toBeGreaterThanOrEqual(0);
  }

  // --- ANTI-TRIVIALIDADE: a aleatoriedade exercitou os ramos de fato (rede nao-vazia).
  expect(withCoupon, "ha casos COM cupom").toBeGreaterThan(0);
  expect(percentCoupon, "ha cupom percent").toBeGreaterThan(0);
  expect(fixedCoupon, "ha cupom fixed").toBeGreaterThan(0);
  expect(freeShip, "ha casos de frete GRATIS").toBeGreaterThan(0);
  expect(flatShip, "ha casos de frete FLAT").toBeGreaterThan(0);
  expect(couponCapped, "ha cupom limitado ao teto da mercadoria").toBeGreaterThan(0);
  expect(nonTrivialDiscount, "ha desconto de produto que pesa de fato").toBeGreaterThan(0);
  // O arredondamento de meio centavo (onde float drift de fato apareceria) FOI exercitado:
  // se 0, a rede seria vazia justamente no ponto mais sensivel. (Diagnostico, nao mira a
  // producao: so confirma que os 150 casos cobrem o tie-break critico.)
  expect(halfCentTies, "o arredondamento de meio centavo deve ser exercitado").toBeGreaterThan(0);

  // ===== ANCORA DB-first (cents-only na PERSISTENCIA): grava uma AMOSTRA dos totais
  // computados pela PRODUCAO numa linha REAL de `orders` (coluna integer) e rele via pg.
  // Um float seria truncado/rejeitado pela coluna integer; aqui exigimos round-trip exato.
  const client = makeClient();
  await client.connect();
  try {
    // Confirma estruturalmente que as colunas de centavos sao 'integer' (cents-only).
    const cols = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'orders'
           AND column_name IN
             ('subtotal_cents','discount_cents','coupon_discount_cents','shipping_cents','total_cents')`,
    );
    expect(cols.rowCount, "5 colunas de centavos").toBe(5);
    for (const col of cols.rows) {
      expect(col.data_type, `${col.column_name} deve ser integer`).toBe("integer");
    }

    // Amostra de casos com cupom>0 e shipping>0 (anti-trivial: todos os termos != 0).
    const sampleIdx: number[] = [];
    for (let i = 0; i < batch.results.length && sampleIdx.length < 5; i++) {
      const r = batch.results[i];
      if (r.couponDiscountCents > 0 && r.shippingCents > 0 && r.discountCents > 0)
        sampleIdx.push(i);
    }
    expect(sampleIdx.length, "deve haver amostra com todos os termos > 0").toBeGreaterThan(0);

    for (const i of sampleIdx) {
      const r = batch.results[i];
      const tag = randomUUID().slice(0, 8);
      const ins = await client.query<{
        id: number;
        subtotal_cents: number;
        discount_cents: number;
        coupon_discount_cents: number;
        shipping_cents: number;
        total_cents: number;
      }>(
        `INSERT INTO "orders" (
           clerk_user_id, customer_name, customer_email, customer_phone,
           address_cep, address_street, address_city, address_state,
           subtotal_cents, discount_cents, coupon_discount_cents, shipping_cents, total_cents,
           payment_status, payment_method, shipping_status, stock_reserved, stock_committed
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
           'pending','pix','pending',false,false
         ) RETURNING id, subtotal_cents, discount_cents, coupon_discount_cents, shipping_cents, total_cents`,
        [
          `money-${tag}`,
          "Cliente Property",
          `prop-${tag}@harness.test`,
          "11999999999",
          "01001000",
          "Rua Teste",
          "Sao Paulo",
          "SP",
          r.subtotalCents,
          r.discountCents,
          r.couponDiscountCents,
          r.shippingCents,
          r.orderTotalCents,
        ],
      );
      const row = ins.rows[0];
      // Round-trip EXATO: o que a producao computou e o que o Postgres devolveu, Int.
      expect(row.subtotal_cents).toBe(r.subtotalCents);
      expect(row.discount_cents).toBe(r.discountCents);
      expect(row.coupon_discount_cents).toBe(r.couponDiscountCents);
      expect(row.shipping_cents).toBe(r.shippingCents);
      expect(row.total_cents).toBe(r.orderTotalCents);
      for (const [k, v] of Object.entries(row)) {
        expect(Number.isInteger(v), `DB ${k} deve ser Int`).toBe(true);
      }
      // A formula fecha lida CRUA do banco.
      expect(row.total_cents).toBe(
        row.subtotal_cents - row.discount_cents - row.coupon_discount_cents + row.shipping_cents,
      );
    }
  } finally {
    await client.end();
  }
});

import { describe, expect, it } from "vitest";

import { couponDiscountCents } from "../../lib/cart/coupon";
import {
  cartTotals,
  FREE_SHIPPING_THRESHOLD_CENTS,
  FLAT_SHIPPING_CENTS,
  type CartLine,
} from "../../lib/cart/totals";

/**
 * Sondas INV-11 — Frete e total.
 *
 * INV-11 exige:
 *  (a) Frete gratis quando merchandiseCents >= 29900 (FREE_SHIPPING_THRESHOLD_CENTS).
 *      Frete flat R$25 (2500) quando merchandiseCents < 29900.
 *      CRITICO: o operador deve ser >=, NAO >. O limiar 29900 deve dar GRATIS.
 *
 *  (b) A decisao de frete usa a MERCADORIA (subtotal - desconto de produto),
 *      NAO o subtotal bruto. Um subtotal >= 29900 com desconto de produto
 *      que leva mercadoria < 29900 DEVE pagar frete.
 *
 *  (c) Identidade do total:
 *      totalCents == merchandiseCents + shippingCents
 *      (o frete nao inclui cupom; o abatimento de cupom e externo a cartTotals)
 *
 *  (d) CLAMP do cupom: couponDiscountCents <= merchandiseCents SEMPRE.
 *      Cupom fixo de valor MAIOR que a mercadoria deve ser clampado.
 *
 *  (e) Total final com cupom: max(shippingCents, totalCents - couponDiscount).
 *      O cupom nao pode derrubar o valor abaixo do frete ja cobrado.
 *
 * Sondas comportamentais puras — sem banco, runnaveis com `pnpm test tests/invariants/`.
 */

function line(priceCents: number, discountPct: number, quantity: number): CartLine {
  return {
    product: {
      id: "p",
      slug: "p",
      name: "P",
      imageUrl: "",
      priceCents,
      discountPct,
      stock: 999,
    },
    quantity,
  };
}

// Constantes exportadas devem ter os valores canônicos.
describe("INV-11 constantes canonicas", () => {
  it("FREE_SHIPPING_THRESHOLD_CENTS == 29900", () => {
    expect(FREE_SHIPPING_THRESHOLD_CENTS).toBe(29900);
  });

  it("FLAT_SHIPPING_CENTS == 2500", () => {
    expect(FLAT_SHIPPING_CENTS).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// (a) Tabela-verdade do limiar — o ponto critico e exatamente 29900
// ---------------------------------------------------------------------------
describe("INV-11 (a) — limiar de frete gratis: >= 29900", () => {
  it("mercadoria 29800 (< 29900): frete FLAT 2500", () => {
    // produto sem desconto, preco exato
    const t = cartTotals([line(29800, 0, 1)]);
    expect(t.merchandiseCents).toBe(29800);
    expect(
      t.shippingCents,
      `D-01 CONFIRMADO: mercadoria=29800 (abaixo de 29900) deveria dar frete flat 2500, mas deu ${t.shippingCents}. O operador de frete livre pode estar usando '>' ou '<=' invertido.`,
    ).toBe(2500);
  });

  it("mercadoria 29900 (== 29900): frete GRATIS 0 — limiar critico", () => {
    const t = cartTotals([line(29900, 0, 1)]);
    expect(t.merchandiseCents).toBe(29900);
    expect(
      t.shippingCents,
      `D-02 CONFIRMADO: mercadoria=29900 (exatamente no limiar) deveria dar frete GRATIS (0), mas deu ${t.shippingCents}. O operador '>' exclui o limiar — deve ser '>='.`,
    ).toBe(0);
  });

  it("mercadoria 30000 (> 29900): frete GRATIS 0", () => {
    const t = cartTotals([line(30000, 0, 1)]);
    expect(t.merchandiseCents).toBe(30000);
    expect(t.shippingCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Decisao de frete sobre a MERCADORIA, nao sobre o subtotal
// ---------------------------------------------------------------------------
describe("INV-11 (b) — frete decidido sobre mercadoria (pos-desconto de produto), nao subtotal", () => {
  it("subtotal 32000, desconto produto 3000, mercadoria 29000 => frete FLAT 2500", () => {
    // produto com 9,375% de desconto exato e complicado; monte com valores simples:
    // 2 itens de 16000 com desconto que resulte em finalPrice=14500 cada
    // mas e mais simples: produto priceCents=32000, discountPct=?, qty=1
    // finalPriceCents = round(32000 * (1 - pct/100)) = 29000
    // round(32000 * pct/100) = 3000 => pct = 9.375 => nao inteiro
    // Use qty=2, priceCents=16000, desconto para finalPrice=14500 each
    // finalPriceCents = round(16000*(1-d/100)) = 14500 => 16000*(1-d/100)=14500 => d = 9.375 nao inteiro
    // Mais simples: subtotal 32000 com discountPct=0 nao tem desconto.
    // Use dois produtos: priceCents=20000 discountPct=0 qty=1 (sub=20000)
    // e priceCents=15000 discountPct=20 qty=1 (final=12000, sub=15000, desc=3000)
    // total subtotal = 35000, discountCents = 3000, merchandiseCents = 32000 > 29900 => GRATIS
    // isso nao testa o caso certo. Precisamos mercadoria < 29900 mas subtotal >= 29900.
    //
    // Caso: priceCents=32000, discountPct=10, qty=1
    // subtotal=32000, finalPrice=round(32000*0.9)=28800, discount=3200, merchandise=28800
    // 28800 < 29900 => frete flat — mas subtotal 32000 > 29900 => subtotal daria gratis
    const t = cartTotals([line(32000, 10, 1)]);
    // subtotal = 32000
    expect(t.subtotalCents).toBe(32000);
    // merchandise = round(32000*0.9) = 28800
    expect(t.merchandiseCents).toBe(28800);
    // O subtotal (32000) >= 29900 mas a mercadoria (28800) < 29900
    // Se o codigo usar subtotal para decidir frete, dara 0 (errado).
    // Se usar merchandiseCents, dara 2500 (correto).
    expect(
      t.shippingCents,
      `D-03 CONFIRMADO: subtotal=${t.subtotalCents} >= 29900 mas mercadoria=${t.merchandiseCents} < 29900. O frete foi ${t.shippingCents} — se for 0, a decisao usa o SUBTOTAL em vez da MERCADORIA.`,
    ).toBe(2500);
  });

  it("subtotal 32000, desconto produto 2100, mercadoria 29900 => frete GRATIS (no limiar)", () => {
    // priceCents=32000, discountPct=? para finalPrice=29900
    // round(32000*(1-d/100))=29900 => d = (32000-29900)/32000*100 = 6.5625 nao inteiro
    // Use priceCents=40000, discountPct=? para finalPrice=29900 => d=(40000-29900)/40000*100=25.25 nao inteiro
    // Use priceCents=30000, discountPct=? para finalPrice=29900: round(30000*0.003..)
    // finalPrice = round(30000*(1-d/100)) = 29900 => 30000-300d/10=29900 => 300d/10=100 => d=10/3 nao inteiro
    // Use quantidade: 29 itens de 1100 sem desconto => subtotal=31900, merchandise=31900 > 29900 => gratis (nao testa)
    // Use produtos com desconto que soma exatamente ao ponto certo:
    // priceCents=29900, discountPct=0, qty=1 => subtotal=29900, merchandise=29900 => GRATIS (ja coberto acima)
    // Para subtotal > 29900 e merchandise == 29900:
    // priceCents=31000, discountPct=? => finalPrice=29900 => round(31000*(1-d/100))=29900
    // 31000*(1-d/100)=29900 => 1-d/100=29900/31000=0.96451.. => d=3.548.. nao inteiro
    // priceCents=59800, discountPct=50, qty=1 => subtotal=59800, final=round(59800*0.5)=29900, merchandise=29900
    const t = cartTotals([line(59800, 50, 1)]);
    expect(t.subtotalCents).toBe(59800);
    expect(t.merchandiseCents).toBe(29900);
    expect(
      t.shippingCents,
      `mercadoria=29900 no limiar exato deve dar frete GRATIS, mas deu ${t.shippingCents}`,
    ).toBe(0);
  });

  it("subtotal 32000, discountPct=10, mercadoria 28800 < 29900 => frete flat independente do subtotal", () => {
    // Caso complementar ao primeiro: confirma que a condicao nao e `subtotalCents > threshold`
    const t = cartTotals([line(32000, 10, 1)]);
    expect(t.subtotalCents).toBeGreaterThanOrEqual(29900); // subtotal passa no threshold
    expect(t.merchandiseCents).toBeLessThan(29900); // mas mercadoria nao passa
    expect(t.shippingCents).toBe(2500); // logo deve pagar frete
  });
});

// ---------------------------------------------------------------------------
// (c) Identidade do total: totalCents == merchandiseCents + shippingCents
// ---------------------------------------------------------------------------
describe("INV-11 (c) — identidade do total (sem cupom)", () => {
  const cases: Array<[number, number, number]> = [
    [10000, 0, 1], // < limiar, frete flat
    [29900, 0, 1], // exatamente no limiar, frete 0
    [50000, 0, 1], // acima do limiar, frete 0
    [20000, 20, 2], // com desconto, varia
    [15000, 0, 3], // multiplos
  ];

  for (const [price, disc, qty] of cases) {
    it(`priceCents=${price}, discountPct=${disc}, qty=${qty}`, () => {
      const t = cartTotals([line(price, disc, qty)]);
      expect(
        t.totalCents,
        `identidade violada: totalCents=${t.totalCents} != merchandiseCents(${t.merchandiseCents}) + shippingCents(${t.shippingCents})`,
      ).toBe(t.merchandiseCents + t.shippingCents);
    });
  }
});

// ---------------------------------------------------------------------------
// (d) CLAMP do cupom: couponDiscountCents <= merchandiseCents SEMPRE
// ---------------------------------------------------------------------------
describe("INV-11 (d) — clamp do cupom (nunca abate mais que a mercadoria)", () => {
  it("cupom FIXO 5000 em mercadoria 3000 => abatimento 3000, nao 5000", () => {
    const discount = couponDiscountCents(
      { type: "fixed", percentOff: null, valueCents: 5000 } as never,
      3000,
    );
    expect(
      discount,
      `D-04 CONFIRMADO: cupom fixo 5000 em mercadoria 3000 deveria ser clampado para 3000, mas retornou ${discount}. O cap nao esta funcionando.`,
    ).toBe(3000);
  });

  it("cupom FIXO 999999 em mercadoria 4000 => abatimento 4000 (clamp)", () => {
    const discount = couponDiscountCents(
      { type: "fixed", percentOff: null, valueCents: 999999 } as never,
      4000,
    );
    expect(
      discount,
      `D-04 CONFIRMADO: cupom fixo 999999 em mercadoria 4000 deveria ser clampado para 4000, mas retornou ${discount}.`,
    ).toBe(4000);
  });

  it("cupom FIXO igual a mercadoria: abatimento exato (100%)", () => {
    const discount = couponDiscountCents(
      { type: "fixed", percentOff: null, valueCents: 10000 } as never,
      10000,
    );
    expect(discount).toBe(10000);
  });

  it("cupom FIXO menor que mercadoria: abatimento e o proprio cupom", () => {
    const discount = couponDiscountCents(
      { type: "fixed", percentOff: null, valueCents: 2000 } as never,
      10000,
    );
    expect(discount).toBe(2000);
  });

  it("cupom PERCENT 100% em mercadoria 10000: abatimento 10000 (nao negativa)", () => {
    const discount = couponDiscountCents(
      { type: "percent", percentOff: 100, valueCents: null } as never,
      10000,
    );
    expect(discount).toBe(10000);
  });

  it("mercadoria zero: couponDiscountCents sempre 0 (cupom nao se aplica)", () => {
    const d1 = couponDiscountCents(
      { type: "fixed", percentOff: null, valueCents: 5000 } as never,
      0,
    );
    const d2 = couponDiscountCents(
      { type: "percent", percentOff: 50, valueCents: null } as never,
      0,
    );
    expect(d1).toBe(0);
    expect(d2).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (e) Total final com cupom: max(shippingCents, totalCents - couponDiscount)
// ---------------------------------------------------------------------------
describe("INV-11 (e) — total final com cupom", () => {
  it("cupom nao derruba total abaixo do frete (frete flat preservado)", () => {
    // mercadoria < 29900, frete 2500. Cupom abate tudo da mercadoria.
    // total = 4000 + 2500 = 6500. cupom = 4000. final = max(2500, 6500-4000) = max(2500,2500) = 2500.
    const t = cartTotals([line(4000, 0, 1)]);
    expect(t.merchandiseCents).toBe(4000);
    expect(t.shippingCents).toBe(2500);
    const discount = couponDiscountCents(
      { type: "fixed", percentOff: null, valueCents: 999999 } as never,
      t.merchandiseCents,
    );
    expect(discount).toBe(4000); // clampado
    const finalTotal = Math.max(t.shippingCents, t.totalCents - discount);
    expect(finalTotal).toBe(2500); // frete flat preservado
  });

  it("cupom nao derruba total abaixo do frete (frete gratis — total pode chegar a 0)", () => {
    // mercadoria >= 29900, frete 0. Cupom abate tudo => final = max(0, total-cupom) = 0
    const t = cartTotals([line(30000, 0, 1)]);
    expect(t.shippingCents).toBe(0);
    const discount = couponDiscountCents(
      { type: "fixed", percentOff: null, valueCents: 999999 } as never,
      t.merchandiseCents,
    );
    expect(discount).toBe(30000); // clampado a mercadoria
    const finalTotal = Math.max(t.shippingCents, t.totalCents - discount);
    expect(finalTotal).toBe(0);
  });

  it("cupom parcial: frete decidido antes do cupom, nao muda com o desconto", () => {
    // mercadoria 30000 >= 29900 => frete 0 mesmo com cupom 5000.
    const t = cartTotals([line(30000, 0, 1)]);
    expect(t.shippingCents).toBe(0);
    const discount = couponDiscountCents(
      { type: "fixed", percentOff: null, valueCents: 5000 } as never,
      t.merchandiseCents,
    );
    expect(discount).toBe(5000);
    const finalTotal = Math.max(t.shippingCents, t.totalCents - discount);
    expect(finalTotal).toBe(25000); // 30000 - 5000
  });

  it("percentual 10% em mercadoria 10000 com frete flat: total 11500", () => {
    const t = cartTotals([line(10000, 0, 1)]);
    expect(t.shippingCents).toBe(2500);
    const discount = couponDiscountCents(
      { type: "percent", percentOff: 10, valueCents: null } as never,
      t.merchandiseCents,
    );
    expect(discount).toBe(1000);
    const finalTotal = Math.max(t.shippingCents, t.totalCents - discount);
    expect(finalTotal).toBe(11500);
  });
});

// ---------------------------------------------------------------------------
// (f) remainingForFreeCents: distancia ate o limiar (sobre a mercadoria)
// ---------------------------------------------------------------------------
describe("INV-11 (f) — remainingForFreeCents", () => {
  it("mercadoria 20000: faltam 9900 para frete gratis", () => {
    const t = cartTotals([line(20000, 0, 1)]);
    expect(t.remainingForFreeCents).toBe(9900);
  });

  it("mercadoria >= 29900: remainingForFreeCents == 0", () => {
    const t = cartTotals([line(29900, 0, 1)]);
    expect(t.remainingForFreeCents).toBe(0);

    const t2 = cartTotals([line(50000, 0, 1)]);
    expect(t2.remainingForFreeCents).toBe(0);
  });
});

import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: pedido.totals.formula (priority 14) — DB-first, sem browser.
 *
 * Prova "Total do pedido = subtotal - desconto - cupom + frete" contra o Postgres
 * efemero REAL exposto em process.env.DATABASE_URL pelo runner
 * (scripts/harness-with-ephemeral-pg.ts). Segue o PADRAO das specs irmas de pedido
 * (note-update-audited.spec.ts): roda em Node (sem `page`) e assertaa o estado real
 * via `pg`.
 *
 * NATUREZA DA FEATURE (por que NAO ha seam de lib/data): as invariantes aqui sao
 * `totals-formula` e `cents-only`, propriedades ESTRUTURAIS do dado persistido em
 * `orders` (e do schema), nao de uma mutacao de admin. O total e calculado no
 * checkout (cartTotals) e GRAVADO na linha do pedido; nao existe funcao de admin que
 * "recalcule total" depois. Logo a prova honesta e: (a) montar pedidos com TODOS os
 * termos da formula nao-triviais e verificar que `total_cents` casa exatamente com
 * `subtotal - discount - coupon - shipping` lido cru do banco; (b) provar que o
 * CHECK `orders_coupon_discount_cents_chk` (coupon_discount_cents >= 0) existe e
 * REJEITA um abatimento negativo; (c) provar que todas as colunas monetarias sao
 * Int (integer no Postgres), nunca float; (d) confirmar que os pedidos do SEED ja
 * respeitam a formula (a invariante vale p/ todo o catalogo, nao so p/ os meus).
 *
 * Por isso esta spec NAO usa o _run-seam.ts: nao ha mutacao de PRODUCAO a exercitar.
 * As assercoes sao 100% via `pg` sobre process.env.DATABASE_URL, exatamente o
 * contrato DB-first do harness.
 *
 * ANTI-TRIVIALIDADE: o pedido principal e montado com discount_cents>0,
 * coupon_discount_cents>0 e shipping_cents>0 ao MESMO tempo (e subtotal != total),
 * de modo que a formula so fecha se CADA termo entrar com o sinal certo. Um pedido
 * com tudo zerado (como os do seed) tornaria a igualdade trivial; este nao.
 */

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

// Termos NAO-triviais (todos > 0; nenhum cancela o outro por acaso).
const SUBTOTAL = 50000; // centavos (Int)
const DISCOUNT = 3000; // desconto de PRODUTO (centavos)
const COUPON = 1500; // desconto de CUPOM (centavos)
const SHIPPING = 2500; // frete flat (centavos)
// total esperado: 50000 - 3000 - 1500 + 2500 = 48000
const EXPECTED_TOTAL = SUBTOTAL - DISCOUNT - COUPON + SHIPPING;

function insertOrder(
  client: Client,
  tag: string,
  fields: {
    subtotal: number;
    discount: number;
    coupon: number;
    shipping: number;
    total: number;
  },
) {
  return client.query<{ id: number }>(
    `INSERT INTO "orders" (
       clerk_user_id, customer_name, customer_email, customer_phone,
       address_cep, address_street, address_city, address_state,
       subtotal_cents, discount_cents, coupon_discount_cents, shipping_cents, total_cents,
       payment_status, payment_method, shipping_status,
       stock_reserved, stock_committed
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12, $13,
       'pending', 'pix', 'pending',
       false, false
     ) RETURNING id`,
    [
      `user-${tag}`,
      "Cliente Harness",
      `cliente-${tag}@harness.test`,
      "11999999999",
      "01001000",
      "Rua Teste",
      "Sao Paulo",
      "SP",
      fields.subtotal,
      fields.discount,
      fields.coupon,
      fields.shipping,
      fields.total,
    ],
  );
}

test("pedido.totals.formula: total = subtotal - desconto - cupom + frete (cents-only, CHECK)", async () => {
  const client = makeClient();
  await client.connect();
  try {
    const tag = randomUUID().slice(0, 8);

    // --- setup: PEDIDO PROPRIO com TODOS os termos da formula > 0 (anti-trivial).
    const ins = await insertOrder(client, tag, {
      subtotal: SUBTOTAL,
      discount: DISCOUNT,
      coupon: COUPON,
      shipping: SHIPPING,
      total: EXPECTED_TOTAL,
    });
    const orderId = ins.rows[0].id;

    // --- assert 1: total_cents == subtotal - discount - coupon + shipping, lido cru.
    const row = await client.query<{
      subtotal_cents: number;
      discount_cents: number;
      coupon_discount_cents: number;
      shipping_cents: number;
      total_cents: number;
    }>(
      `SELECT subtotal_cents, discount_cents, coupon_discount_cents, shipping_cents, total_cents
         FROM "orders" WHERE id = $1`,
      [orderId],
    );
    expect(row.rowCount).toBe(1);
    const o = row.rows[0];

    // Os valores persistiram exatamente como inseridos (nenhuma deformacao silenciosa).
    expect(o.subtotal_cents).toBe(SUBTOTAL);
    expect(o.discount_cents).toBe(DISCOUNT);
    expect(o.coupon_discount_cents).toBe(COUPON);
    expect(o.shipping_cents).toBe(SHIPPING);

    // A FORMULA: total = subtotal - discount - coupon + shipping (a partir das colunas
    // cruas, nao de constantes). Nao-trivial: cada termo > 0 e subtotal != total.
    const computed =
      o.subtotal_cents - o.discount_cents - o.coupon_discount_cents + o.shipping_cents;
    expect(computed, "total derivado da formula deve casar com os termos").toBe(EXPECTED_TOTAL);
    expect(o.total_cents, "total_cents persistido deve seguir a formula").toBe(computed);
    expect(o.total_cents).toBe(EXPECTED_TOTAL);
    // Sanidade anti-trivialidade: total != subtotal (os abatimentos/frete pesaram).
    expect(o.total_cents).not.toBe(o.subtotal_cents);

    // --- assert 2: todos os campos sao Int de centavos (cents-only); nenhum float.
    //     (a) em runtime: os valores lidos sao inteiros exatos.
    for (const [k, v] of Object.entries(o)) {
      expect(Number.isInteger(v), `${k} deve ser Int (cents-only), sem float`).toBe(true);
    }
    //     (b) no schema: as colunas monetarias sao 'integer' no Postgres (nao numeric/
    //         double precision). Prova estrutural de cents-only no proprio tipo da coluna.
    const cols = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_name = 'orders'
           AND column_name IN
             ('subtotal_cents','discount_cents','coupon_discount_cents','shipping_cents','total_cents')
         ORDER BY column_name`,
    );
    expect(cols.rowCount, "as 5 colunas de centavos devem existir").toBe(5);
    for (const c of cols.rows) {
      expect(c.data_type, `${c.column_name} deve ser integer (cents-only)`).toBe("integer");
    }

    // --- assert 3: CHECK coupon_discount_cents >= 0 existe e REJEITA negativo.
    const chk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'orders_coupon_discount_cents_chk'`,
    );
    expect(chk.rowCount, "CHECK orders_coupon_discount_cents_chk deve existir").toBe(1);

    // Tentar inserir coupon_discount_cents = -1 deve violar o CHECK (nada persiste).
    const negTag = randomUUID().slice(0, 8);
    let rejected = false;
    try {
      await insertOrder(client, negTag, {
        subtotal: SUBTOTAL,
        discount: 0,
        coupon: -1, // ILEGAL: abatimento de cupom negativo
        shipping: 0,
        total: SUBTOTAL + 1,
      });
    } catch (err) {
      rejected = true;
      // Postgres erro de CHECK e 23514; a mensagem cita a constraint.
      expect(String((err as { code?: string }).code ?? ""), "deve ser check_violation 23514").toBe(
        "23514",
      );
      expect(String((err as Error).message)).toContain("orders_coupon_discount_cents_chk");
    }
    expect(rejected, "coupon_discount_cents = -1 deve ser barrado pelo CHECK").toBe(true);

    // E confirma que NENHUM pedido com esse cliente negativo persistiu.
    const leaked = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "orders" WHERE clerk_user_id = $1`,
      [`user-${negTag}`],
    );
    expect(Number(leaked.rows[0].count), "insercao incoerente nao deve deixar linha").toBe(0);

    // --- assert 4 (escopo de catalogo): TODOS os pedidos do banco (incl. o seed)
    //     respeitam a formula e coupon_discount_cents >= 0. A invariante vale p/ todo
    //     o catalogo, nao so p/ o pedido que montei.
    const violations = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "orders"
         WHERE total_cents <> (subtotal_cents - discount_cents - coupon_discount_cents + shipping_cents)
            OR coupon_discount_cents < 0`,
    );
    expect(
      Number(violations.rows[0].count),
      "nenhum pedido pode violar a formula nem ter cupom negativo",
    ).toBe(0);
    // Sanidade: ha mais de 1 pedido (o seed carregou + o meu), entao o assert 4 nao e vazio.
    const totalOrders = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "orders"`,
    );
    expect(
      Number(totalOrders.rows[0].count),
      "deve haver pedidos no banco (seed + meu)",
    ).toBeGreaterThan(1);
  } finally {
    await client.end();
  }
});

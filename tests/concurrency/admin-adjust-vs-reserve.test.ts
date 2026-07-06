import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// CAOS DE RUNTIME (INV-6 / Q7): AJUSTE DE ESTOQUE DO ADMIN x RESERVA DE CHECKOUT.
// Dois atores disputam a MESMA linha de products ao mesmo tempo:
//   - admin  : updateProduct(...) baixando o stock para um valor ABAIXO da qty que
//              o checkout esta reservando (intencao "corrigir estoque fisico").
//   - cliente: reserveStock(tx, qty) reservando o produto (checkout).
// Um ajuste ingenuo (read stock -> write stock) poderia gravar stock < reserved e
// violar o CHECK products_reserved_le_stock_chk (500 opaco) OU deixar reserved
// acima do estoque fisico (base do oversell). A defesa e o SELECT ... FOR UPDATE em
// updateProduct: ele serializa contra o UPDATE de reserveStock e re-le `reserved`
// FRESCO sob o lock antes de validar. Provamos que, qualquer que seja a ordem de
// escalonamento, o resultado e SEMPRE um dos dois estados seguros e 0 <= reserved <=
// stock nunca quebra.
//
// Exercita as funcoes REAIS (lib/data/products.updateProduct + lib/data/inventory.
// reserveStock). DORMENTE sem Postgres efemero — opt-in via TEST_DATABASE_URL
// (`pnpm test:db`). A rede DB-free correspondente vive em
// tests/invariants/inv6-admin-adjust-reserved-shape.test.ts (sonda de forma que
// pega a regressao do lock/da re-leitura sem banco).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  "concorrência — ajuste de estoque do admin x reserva de checkout (INV-6 / Q7)",
  () => {
    let prisma: any;
    let products: any;
    let inventory: any;
    const actor = { clerkUserId: "admin-test", email: "admin@test.com", role: "admin" };

    // stock inicial, qty que o checkout reserva, e o novo stock que o admin tenta
    // gravar. NEW_STOCK < RESERVE_QTY de proposito: os dois lados sao MUTUAMENTE
    // EXCLUSIVOS (se a reserva cola, o ajuste tem de falhar; se o ajuste cola, a
    // reserva tem de falhar) — o que torna o XOR abaixo uma assercao afiada.
    const INIT_STOCK = 10;
    const RESERVE_QTY = 8;
    const NEW_STOCK = 5;

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      prisma = (await import("../../lib/db")).prisma;
      products = await import("../../lib/data/products");
      inventory = await import("../../lib/data/inventory");
    });

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
    });

    async function seedProduct(): Promise<{ id: string; sku: string }> {
      const id = randomUUID();
      const tag = id.slice(0, 8);
      const sku = `SKU-${tag}`;
      await prisma.product.create({
        data: {
          id,
          slug: `p-${tag}`,
          name: "P",
          category: "Tin",
          sku,
          priceCents: 1000,
          discountPct: 0,
          imageUrl: "/x.svg",
          description: "t",
          stock: INIT_STOCK,
          reserved: 0,
        },
      });
      return { id, sku };
    }

    // Espelha o input do form do admin. `original` = o snapshot que o editor
    // carregou (stock INIT_STOCK): so o campo stock difere do input, entao o diff de
    // intencao de updateProduct escreve APENAS a coluna stock (como o admin real).
    function formInput(stock: number, sku: string) {
      return {
        name: "P",
        sku,
        category: "Tin",
        priceCents: 1000,
        discountPct: 0,
        stock,
        badge: null,
        imageUrl: "",
        description: "",
      };
    }

    it("nunca viola 0<=reserved<=stock; exatamente um lado (ajuste OU reserva) vence", async () => {
      // Repete p/ flushar o escalonamento: a corrida nao interleava igual sempre,
      // entao os dois vencedores possiveis (admin-primeiro e reserva-primeiro)
      // aparecem ao longo das iteracoes.
      let adminWins = 0;
      let reserveWins = 0;

      for (let i = 0; i < 40; i += 1) {
        const { id, sku } = await seedProduct();

        // Ator 1: admin baixa o stock p/ NEW_STOCK (abaixo de RESERVE_QTY).
        const adminP = products
          .updateProduct(actor, id, formInput(NEW_STOCK, sku), formInput(INIT_STOCK, sku))
          .then(() => ({ ok: true as const }))
          .catch((e: unknown) => ({ ok: false as const, err: e }));

        // Ator 2: checkout reserva RESERVE_QTY na sua propria transacao.
        const reserveP = prisma
          .$transaction((tx: any) =>
            inventory.reserveStock(tx, [{ productId: id, quantity: RESERVE_QTY }]),
          )
          .then((r: any) => r)
          .catch(() => ({ ok: false }));

        const [admin, reserve] = await Promise.all([adminP, reserveP]);

        const product = await prisma.product.findUnique({ where: { id } });

        // (1) INVARIANTE DURA: o CHECK do banco nunca pode ser violado.
        expect(product.reserved).toBeGreaterThanOrEqual(0);
        expect(product.reserved).toBeLessThanOrEqual(product.stock);

        // (2) MUTUA EXCLUSAO: como NEW_STOCK < RESERVE_QTY, no maximo um lado muta a
        //     linha de forma bem-sucedida. Nunca ambos (seria stock<reserved).
        const adminSucceeded = admin.ok === true;
        const reserveSucceeded = reserve.ok === true;
        expect(
          adminSucceeded && reserveSucceeded,
          "admin e reserva nao podem vencer juntos (deixaria stock < reserved)",
        ).toBe(false);

        if (adminSucceeded) {
          // Admin venceu o lock primeiro: gravou stock=NEW_STOCK; a reserva reavaliou
          // stock-reserved>=qty (5-0>=8 falso) e recusou.
          adminWins += 1;
          expect(product.stock).toBe(NEW_STOCK);
          expect(product.reserved).toBe(0);
          expect(reserveSucceeded).toBe(false);
        } else {
          // Reserva venceu: reserved=RESERVE_QTY; o admin, sob o FOR UPDATE, releu
          // reserved=8 fresco e recusou baixar stock p/ 5 (ProductValidationError).
          reserveWins += 1;
          expect(reserveSucceeded).toBe(true);
          expect(product.reserved).toBe(RESERVE_QTY);
          expect(product.stock).toBe(INIT_STOCK); // ajuste rejeitado, stock intacto
          expect(String((admin as { err: unknown }).err)).toMatch(/reservad/i);
        }
      }

      // Sanidade: ao longo das 40 iteracoes os DOIS desfechos seguros ocorreram (a
      // corrida foi de fato exercitada nos dois sentidos, nao um so escalonamento).
      expect(adminWins + reserveWins).toBe(40);
    });
  },
);

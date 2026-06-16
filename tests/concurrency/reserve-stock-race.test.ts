import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// CAOS DE RUNTIME (INV-6): corrida no ULTIMO item. N checkouts simultaneos
// disputam a ultima unidade. O invariante 0 <= reserved <= stock (sem oversell)
// deve valer SEMPRE, garantido pelo guard coluna-a-coluna de reserveStock
// (UPDATE ... WHERE stock - reserved >= qty) + o row-lock do UPDATE, que serializa
// os concorrentes em READ COMMITTED (recheck do predicado apos o lock).
//
// Este e o tipo de invariante que regressao unitaria NAO pega: so aparece sob
// concorrencia real contra Postgres. Exercita a funcao REAL (lib/data/inventory).
// Opt-in via TEST_DATABASE_URL (use `pnpm test:db`).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  "concorrência — corrida no último item (reserveStock, INV-6)",
  () => {
    let prisma: any;
    let inventory: any;

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      prisma = (await import("../../lib/db")).prisma;
      inventory = await import("../../lib/data/inventory");
    });

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
    });

    async function seedProduct(stock: number): Promise<string> {
      const id = randomUUID();
      const tag = id.slice(0, 8);
      await prisma.product.create({
        data: {
          id,
          slug: `p-${tag}`,
          name: `T ${tag}`,
          category: "Tin",
          sku: `SKU-${tag}`,
          priceCents: 1000,
          imageUrl: "/x.svg",
          description: "t",
          stock,
          reserved: 0,
        },
      });
      return id;
    }

    // Cada "checkout" reserva 1 unidade na sua propria transacao.
    function reserveOne(productId: string) {
      return prisma.$transaction((tx: any) =>
        inventory.reserveStock(tx, [{ productId, quantity: 1 }]),
      );
    }

    it("N reservas concorrentes na última unidade: exatamente 1 vence, sem oversell", async () => {
      // Repete para flushar o escalonamento (a corrida nao interleava igual sempre).
      for (let i = 0; i < 30; i += 1) {
        const productId = await seedProduct(1); // estoque = 1 (ultima unidade)
        const results = await Promise.all(Array.from({ length: 5 }, () => reserveOne(productId)));

        const won = results.filter((r: any) => r.ok).length;
        const product = await prisma.product.findUnique({ where: { id: productId } });

        expect(won).toBe(1); // so um checkout leva a ultima unidade
        expect(product.reserved).toBe(1); // reservado exatamente 1 (nunca 2+)
        expect(product.reserved).toBeLessThanOrEqual(product.stock); // 0 <= reserved <= stock
      }
    });

    it("estoque suficiente: todas as reservas concorrentes vencem, reserved == N", async () => {
      for (let i = 0; i < 20; i += 1) {
        const n = 5;
        const productId = await seedProduct(n); // estoque = N
        const results = await Promise.all(Array.from({ length: n }, () => reserveOne(productId)));

        const won = results.filter((r: any) => r.ok).length;
        const product = await prisma.product.findUnique({ where: { id: productId } });

        expect(won).toBe(n); // todas cabem
        expect(product.reserved).toBe(n);
        expect(product.reserved).toBeLessThanOrEqual(product.stock);
      }
    });
  },
);

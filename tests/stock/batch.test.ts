import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do batch de estoque (achado 🟡 "inventory.ts faz 1 UPDATE por item"):
// reserveStock/releaseStock/commitStock/restockUnits agora fazem UM statement por
// operacao via `UPDATE ... FROM (VALUES ...)`. Cobrimos:
//   1. reserveStock em lote: reserva todos quando cabe; quando UM item nao cabe,
//      retorna ok:false com o productId correto e NAO deixa reserva parcial
//      observavel (o chamador faz rollback — mesmo padrao de orders.ts).
//   2. armadilha do productId DUPLICADO: as quantidades sao somadas (1 linha-alvo
//      so e atualizada uma vez pelo FROM (VALUES ...)).
//   3. commit/release/restock em lote == efeito do loop antigo.
// Opt-in via TEST_DATABASE_URL (Postgres descartavel). Sem ela, a suite e PULADA.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("estoque em lote (inventory.ts)", () => {
  // Tipos frouxos: client gerado + funcoes carregados dinamicamente e so quando
  // ha DB (lib/db le DATABASE_URL no load).
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

  async function seedProduct(stock: number, reserved = 0): Promise<string> {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await prisma.product.create({
      data: {
        id,
        slug: `p-${tag}`,
        name: `Test ${tag}`,
        category: "Tin",
        sku: `SKU-${tag}`,
        priceCents: 1000,
        imageUrl: "/x.svg",
        description: "test",
        stock,
        reserved,
      },
    });
    return id;
  }

  function read(id: string) {
    return prisma.product.findUnique({ where: { id } });
  }

  it("reserveStock em lote reserva TODOS os itens quando ha disponibilidade", async () => {
    const a = await seedProduct(5);
    const b = await seedProduct(5, 1);

    const res = await prisma.$transaction((tx: any) =>
      inventory.reserveStock(tx, [
        { productId: a, quantity: 3 },
        { productId: b, quantity: 2 },
      ]),
    );

    expect(res.ok).toBe(true);
    expect((await read(a)).reserved).toBe(3);
    expect((await read(b)).reserved).toBe(3); // 1 + 2
  });

  it("reserveStock: quando UM item nao cabe, ok:false c/ productId certo e SEM reserva parcial", async () => {
    const a = await seedProduct(5); // cabe
    const b = await seedProduct(1); // NAO cabe (pede 4)

    // Espelha o chamador real (orders.ts): ok:false -> throw -> rollback da tx.
    // Assim qualquer reserva parcial do item que cabia e descartada.
    await expect(
      prisma.$transaction(async (tx: any) => {
        const res = await inventory.reserveStock(tx, [
          { productId: a, quantity: 3 },
          { productId: b, quantity: 4 },
        ]);
        if (!res.ok) {
          expect(res.productId).toBe(b); // o item que faltou (id real do input)
          throw new Error("rollback");
        }
        return res;
      }),
    ).rejects.toThrow("rollback");

    // Estado final: NADA reservado (rollback desfez o que cabia).
    expect((await read(a)).reserved).toBe(0);
    expect((await read(b)).reserved).toBe(0);
  });

  it("reserveStock com productId DUPLICADO soma as quantidades (armadilha do VALUES)", async () => {
    const a = await seedProduct(5);

    // 2 + 2 = 4 <= 5: o loop antigo somaria; o batch tambem precisa somar.
    const res = await prisma.$transaction((tx: any) =>
      inventory.reserveStock(tx, [
        { productId: a, quantity: 2 },
        { productId: a, quantity: 2 },
      ]),
    );
    expect(res.ok).toBe(true);
    expect((await read(a)).reserved).toBe(4); // NAO 2

    // Soma que estoura: 3 + 3 = 6 > 5 -> ok:false, reserva inalterada.
    const b = await seedProduct(5);
    const fail = await prisma.$transaction((tx: any) =>
      inventory.reserveStock(tx, [
        { productId: b, quantity: 3 },
        { productId: b, quantity: 3 },
      ]),
    );
    expect(fail.ok).toBe(false);
    expect(fail.productId).toBe(b);
    expect((await read(b)).reserved).toBe(0);
  });

  it("reserveStock com items vazio e no-op (ok:true)", async () => {
    const res = await prisma.$transaction((tx: any) => inventory.reserveStock(tx, []));
    expect(res.ok).toBe(true);
  });

  it("commitStock em lote: stock -= soma, reserved -= soma (== loop antigo)", async () => {
    const a = await seedProduct(10, 4);
    const b = await seedProduct(8, 5);

    await prisma.$transaction((tx: any) =>
      inventory.commitStock(tx, [
        { productId: a, quantity: 3 },
        { productId: b, quantity: 2 },
      ]),
    );

    const pa = await read(a);
    const pb = await read(b);
    expect(pa.stock).toBe(7);
    expect(pa.reserved).toBe(1);
    expect(pb.stock).toBe(6);
    expect(pb.reserved).toBe(3);
  });

  it("commitStock soma duplicados antes de baixar", async () => {
    const a = await seedProduct(10, 5);
    await prisma.$transaction((tx: any) =>
      inventory.commitStock(tx, [
        { productId: a, quantity: 2 },
        { productId: a, quantity: 3 },
      ]),
    );
    const pa = await read(a);
    expect(pa.stock).toBe(5); // 10 - 5
    expect(pa.reserved).toBe(0); // 5 - 5
  });

  it("releaseStock em lote: reserved -= soma (inclui duplicados)", async () => {
    const a = await seedProduct(10, 6);
    await prisma.$transaction((tx: any) =>
      inventory.releaseStock(tx, [
        { productId: a, quantity: 2 },
        { productId: a, quantity: 3 },
      ]),
    );
    expect((await read(a)).reserved).toBe(1); // 6 - 5, stock intacto
    expect((await read(a)).stock).toBe(10);
  });

  it("restockUnits em lote: stock += soma (inclui duplicados), reserved intacto", async () => {
    const a = await seedProduct(8, 2);
    await prisma.$transaction((tx: any) =>
      inventory.restockUnits(tx, [
        { productId: a, quantity: 1 },
        { productId: a, quantity: 4 },
      ]),
    );
    const pa = await read(a);
    expect(pa.stock).toBe(13); // 8 + 5
    expect(pa.reserved).toBe(2); // intacto
  });

  it("release/commit/restock com items vazio sao no-op", async () => {
    const a = await seedProduct(5, 2);
    await prisma.$transaction(async (tx: any) => {
      await inventory.releaseStock(tx, []);
      await inventory.commitStock(tx, []);
      await inventory.restockUnits(tx, []);
    });
    const pa = await read(a);
    expect(pa.stock).toBe(5);
    expect(pa.reserved).toBe(2);
  });
});

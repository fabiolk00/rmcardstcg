import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do ajuste de estoque do admin respeitando `reserved` (achado P1 do stock):
// definir stock < reserved deve dar erro CLARO (ProductValidationError), nao um
// 500 opaco por violacao do CHECK reserved<=stock. Opt-in via TEST_DATABASE_URL.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("admin: ajuste de estoque respeita reserved", () => {
  let prisma: any;
  let products: any;
  const actor = { clerkUserId: "admin-test", email: "admin@test.com", role: "admin" };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = (await import("../../lib/db")).prisma;
    products = await import("../../lib/data/products");
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function seed(reserved: number, stock = 10): Promise<{ id: string; sku: string }> {
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
        imageUrl: "/x.svg",
        description: "t",
        stock,
        reserved,
      },
    });
    return { id, sku };
  }

  function input(stock: number, sku: string) {
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

  it("rejeita estoque abaixo do reservado com mensagem clara (não 500 opaco)", async () => {
    const { id, sku } = await seed(8); // reserved=8, stock=10
    await expect(products.updateProduct(actor, id, input(5, sku))).rejects.toThrow(/reservad/i);
    const p = await prisma.product.findUnique({ where: { id } });
    expect(p.stock).toBe(10); // inalterado
  });

  it("aceita estoque >= reservado", async () => {
    const { id, sku } = await seed(8);
    await products.updateProduct(actor, id, input(8, sku));
    const p = await prisma.product.findUnique({ where: { id } });
    expect(p.stock).toBe(8);
  });
});

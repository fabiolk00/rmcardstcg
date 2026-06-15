import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// uniqueSlug agora resolve a familia base / base-N numa unica query (antes era um
// findUnique por colisao). Este teste prova a CORRETUDE do batch: nomes repetidos
// geram slugs sequenciais e unicos. Opt-in via TEST_DATABASE_URL.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("createProduct: slugs únicos para nomes repetidos", () => {
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

  it("gera base, base-2, base-3, base-4 sem colisão", async () => {
    const name = `Repetido ${randomUUID().slice(0, 6)}`;
    const slugs: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const p = await products.createProduct(actor, {
        name,
        sku: `SKU-${randomUUID().slice(0, 8)}`,
        category: "Tin",
        priceCents: 1000,
        discountPct: 0,
        stock: 0,
        badge: null,
        imageUrl: "",
        description: "",
      });
      slugs.push(p.slug);
    }
    expect(new Set(slugs).size).toBe(4); // todos únicos
    const base = slugs[0];
    expect(slugs[1]).toBe(`${base}-2`);
    expect(slugs[2]).toBe(`${base}-3`);
    expect(slugs[3]).toBe(`${base}-4`);
  });
});

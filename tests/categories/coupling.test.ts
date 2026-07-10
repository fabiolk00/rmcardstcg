import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do ACOPLAMENTO POR NOME (2026-07-10): a tabela `categories` virou a FONTE
// DE VERDADE das categorias de produto (sem FK — coupling pelo NOME).
//  - createProduct/updateProduct so aceitam categoria que EXISTA na tabela;
//  - renomear categoria faz CASCADE em products.category (mesma transacao) — sem orfao;
//  - excluir categoria EM USO por produto e BLOQUEADO (com contagem).
// Opt-in via TEST_DATABASE_URL (igual as demais suites de DB).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ACTOR = { clerkUserId: null, email: null, role: null };

describe.skipIf(!TEST_DATABASE_URL)("category coupling (por nome)", () => {
  let prisma: any;
  let categories: any;
  let products: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = (await import("../../lib/db")).prisma;
    categories = await import("../../lib/data/categories");
    products = await import("../../lib/data/products");
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function makeCategory(): Promise<{ id: string; name: string }> {
    const name = `Cat ${randomUUID().slice(0, 8)}`;
    const r = await categories.createCategory(ACTOR, { name, description: null });
    if (!r.ok) throw new Error("setup: createCategory falhou");
    return { id: r.category.id, name };
  }

  function productInput(category: string) {
    return {
      name: `Produto ${randomUUID().slice(0, 6)}`,
      category,
      sku: `SKU-${randomUUID().slice(0, 8)}`,
      priceCents: 1000,
      discountPct: 0,
      stock: 3,
      badge: null,
      imageUrl: "/products/placeholder.svg",
      description: "x",
      isLanding: false,
      weightGrams: 0,
      lengthCm: 0,
      widthCm: 0,
      heightCm: 0,
    };
  }

  it("createProduct REJEITA categoria que nao existe na tabela", async () => {
    await expect(
      products.createProduct(ACTOR, productInput(`Fantasma ${randomUUID().slice(0, 6)}`)),
    ).rejects.toThrow(/não existe/i);
  });

  it("createProduct ACEITA categoria existente na tabela", async () => {
    const cat = await makeCategory();
    const p = await products.createProduct(ACTOR, productInput(cat.name));
    expect(p.category).toBe(cat.name);
  });

  it("updateProduct REJEITA troca para categoria inexistente", async () => {
    const cat = await makeCategory();
    const p = await products.createProduct(ACTOR, productInput(cat.name));
    await expect(
      products.updateProduct(ACTOR, p.id, { ...productInput(cat.name), category: "Inexistente ZZZ" }),
    ).rejects.toThrow(/não existe/i);
  });

  it("updateCategory RENOMEIA e faz cascade em products.category (sem orfao)", async () => {
    const cat = await makeCategory();
    const p = await products.createProduct(ACTOR, productInput(cat.name));

    const newName = `Cat ${randomUUID().slice(0, 8)}`;
    const upd = await categories.updateCategory(ACTOR, cat.id, { name: newName, description: null });
    expect(upd.ok).toBe(true);

    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh.category).toBe(newName); // produto seguiu a categoria renomeada
  });

  it("deleteCategory BLOQUEIA quando ha produto usando a categoria", async () => {
    const cat = await makeCategory();
    await products.createProduct(ACTOR, productInput(cat.name));

    const res = await categories.deleteCategory(ACTOR, cat.id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/produto/i);

    // A categoria NAO foi removida (guarda impediu).
    const still = await prisma.category.findUnique({ where: { id: cat.id } });
    expect(still).not.toBeNull();
  });

  it("deleteCategory PERMITE apos a categoria ficar sem produtos", async () => {
    const cat = await makeCategory();
    const p = await products.createProduct(ACTOR, productInput(cat.name));

    // Move o produto para outra categoria; a original fica livre.
    const other = await makeCategory();
    await products.updateProduct(ACTOR, p.id, { ...productInput(other.name), sku: p.sku });

    const res = await categories.deleteCategory(ACTOR, cat.id);
    expect(res.ok).toBe(true);
    const gone = await prisma.category.findUnique({ where: { id: cat.id } });
    expect(gone).toBeNull();
  });
});

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova de runtime (Postgres efemero) do ciclo de moderacao de avaliacoes:
//   - submitReview cria 'pending' e NAO mexe no agregado do produto;
//   - approve recalcula Product.rating/reviewCount a partir das APROVADAS + audita;
//   - segundo approve atualiza a media; reject de aprovada REVERTE o agregado;
//   - idempotencia: re-aprovar = no-op (sem audit duplicado, sem mexer no agregado);
//   - UNIQUE (produto,usuario) barra segunda review do mesmo autor (already_reviewed);
//   - CHECK rating BETWEEN 1 AND 5 (rede final do banco).
// Opt-in via TEST_DATABASE_URL (Postgres descartavel). Sem ela, a suite e PULADA.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const SYSTEM_ACTOR = { clerkUserId: null, email: null, role: null };

describe.skipIf(!TEST_DATABASE_URL)("moderacao + recalc de avaliacoes (reviews.ts)", () => {
  let prisma: any;
  let reviews: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = (await import("../../lib/db")).prisma;
    reviews = await import("../../lib/data/reviews");
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function seedProduct(): Promise<string> {
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
        stock: 10,
        // Valores decorativos (como o seed): o recalc deve sobrescrever na 1a aprovacao.
        rating: 4.9,
        reviewCount: 120,
      },
    });
    return id;
  }

  const read = (id: string) => prisma.product.findUnique({ where: { id } });
  const auditCount = (reviewId: string, action: string) =>
    prisma.auditLog.count({ where: { entityType: "review", entityId: reviewId, action } });

  async function submit(productId: string, user: string, rating: number) {
    const res = await reviews.submitReview({
      productId,
      userId: user,
      authorName: `User ${user.slice(0, 4)}`,
      rating,
      title: null,
      body: "Produto muito bom, recomendo bastante!",
    });
    if (!res.ok) throw new Error(`submit falhou: ${res.reason}`);
    return res.review.id as string;
  }

  it("submit cria pending sem tocar no agregado; approve recalcula + audita", async () => {
    const p = await seedProduct();
    const r1 = await submit(p, `u-${randomUUID()}`, 5);

    // Pending: agregado decorativo intacto.
    let prod = await read(p);
    expect(Number(prod.rating)).toBe(4.9);
    expect(prod.reviewCount).toBe(120);

    const res = await reviews.setReviewStatus(SYSTEM_ACTOR, r1, "approved");
    expect(res.ok && res.changed).toBe(true);

    // Recalc autoritativo: 1 aprovada nota 5 -> 5.0 / 1.
    prod = await read(p);
    expect(Number(prod.rating)).toBe(5);
    expect(prod.reviewCount).toBe(1);
    expect(await auditCount(r1, "review_approve")).toBe(1);

    // Segunda aprovada (nota 3) -> media (5+3)/2 = 4.0 / 2.
    const r2 = await submit(p, `u-${randomUUID()}`, 3);
    await reviews.setReviewStatus(SYSTEM_ACTOR, r2, "approved");
    prod = await read(p);
    expect(Number(prod.rating)).toBe(4);
    expect(prod.reviewCount).toBe(2);

    // Reject da aprovada nota 3 -> volta para 5.0 / 1.
    const rej = await reviews.setReviewStatus(SYSTEM_ACTOR, r2, "rejected");
    expect(rej.ok && rej.changed).toBe(true);
    prod = await read(p);
    expect(Number(prod.rating)).toBe(5);
    expect(prod.reviewCount).toBe(1);
    expect(await auditCount(r2, "review_reject")).toBe(1);
  });

  it("idempotencia: re-aprovar e no-op (sem mexer no agregado nem duplicar audit)", async () => {
    const p = await seedProduct();
    const r = await submit(p, `u-${randomUUID()}`, 4);
    await reviews.setReviewStatus(SYSTEM_ACTOR, r, "approved");

    const again = await reviews.setReviewStatus(SYSTEM_ACTOR, r, "approved");
    expect(again.ok && again.changed).toBe(false);

    const prod = await read(p);
    expect(prod.reviewCount).toBe(1);
    expect(Number(prod.rating)).toBe(4);
    expect(await auditCount(r, "review_approve")).toBe(1);
  });

  it("UNIQUE (produto, usuario): segunda review do mesmo autor -> already_reviewed", async () => {
    const p = await seedProduct();
    const user = `u-${randomUUID()}`;
    await submit(p, user, 5);

    const second = await reviews.submitReview({
      productId: p,
      userId: user,
      authorName: "Mesmo autor",
      rating: 4,
      title: null,
      body: "Tentando avaliar de novo o mesmo produto.",
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("already_reviewed");
  });

  it("CHECK rating BETWEEN 1 AND 5 (rede final do banco)", async () => {
    const p = await seedProduct();
    await expect(
      prisma.review.create({
        data: {
          productId: p,
          userId: `u-${randomUUID()}`,
          authorName: "Fora da faixa",
          rating: 6,
          body: "nota invalida no banco",
          status: "pending",
        },
      }),
    ).rejects.toBeTruthy();
  });
});

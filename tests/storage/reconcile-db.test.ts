import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integração com banco: reconcile completo + cleanup pós-commit no updateProduct.
 * Opt-in via TEST_DATABASE_URL (Postgres efêmero). O Storage é simulado por um stub
 * de fetch (o pg usa socket, não fetch — os dois não colidem).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SUPA_URL = "https://proj.supabase.co";
const BUCKET = "tcg";
const ownedUrl = (name: string) =>
  `${SUPA_URL}/storage/v1/object/public/${BUCKET}/products/${name}`;

describe.skipIf(!TEST_DATABASE_URL)("storage: reconcile + cleanup pós-commit", () => {
  let prisma: any;
  let products: any;
  let orphans: any;
  const actor = { clerkUserId: "admin-test", email: "admin@test.com", role: "admin" };

  // Estado do Storage simulado.
  let deleted: string[] = [];
  let listRows: Array<{ name: string; id: string | null; created_at?: string | null }> = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPA_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    delete process.env.SUPABASE_STORAGE_BUCKET;
    prisma = (await import("../../lib/db")).prisma;
    products = await import("../../lib/data/products");
    orphans = await import("../../lib/services/supabase/orphans");
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(() => {
    deleted = [];
    listRows = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") {
          deleted.push(url);
          return { ok: true, status: 200 } as unknown as Response;
        }
        // list (POST /object/list/<bucket>)
        return {
          ok: true,
          status: 200,
          json: async () => listRows,
          text: async () => "",
        } as unknown as Response;
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  async function seed(imageUrl: string): Promise<{ id: string; sku: string; name: string }> {
    const tag = randomUUID().slice(0, 8);
    const sku = `SKU-${tag}`;
    const name = `P ${tag}`;
    const { id } = await prisma.product.create({
      data: {
        id: randomUUID(),
        slug: `p-${tag}`,
        name,
        category: "Tin",
        sku,
        priceCents: 1000,
        imageUrl,
        description: "t",
        stock: 5,
        reserved: 0,
      },
    });
    return { id, sku, name };
  }

  function input(over: Record<string, unknown>) {
    return {
      name: "P",
      sku: "SKU",
      category: "Tin",
      priceCents: 1000,
      discountPct: 0,
      stock: 5,
      badge: null,
      imageUrl: "",
      description: "",
      isLanding: false,
      weightGrams: 0,
      lengthCm: 0,
      widthCm: 0,
      heightCm: 0,
      ...over,
    };
  }

  it("reconcile remove só a órfã fora da carência; protege referenciadas e recentes", async () => {
    const a = `${randomUUID()}.png`;
    const b = `${randomUUID()}.png`;
    const orphanOld = `${randomUUID()}.png`;
    const orphanNew = `${randomUUID()}.png`;
    await seed(ownedUrl(a));
    await seed(ownedUrl(b));

    const nowMs = Date.parse("2026-07-06T12:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    listRows = [
      { name: a, id: "1", created_at: iso(nowMs - 72 * 3600_000) }, // referenciada
      { name: b, id: "2", created_at: iso(nowMs - 72 * 3600_000) }, // referenciada
      { name: orphanOld, id: "3", created_at: iso(nowMs - 48 * 3600_000) }, // ÓRFÃ removível
      { name: orphanNew, id: "4", created_at: iso(nowMs - 1 * 3600_000) }, // órfã recente
    ];

    const report = await orphans.reconcileOrphanProductImages({ nowMs });

    expect(report.orphans).toBe(1);
    expect(report.deleted).toBe(1);
    expect(report.skippedRecent).toBe(1);
    expect(deleted).toEqual([`${SUPA_URL}/storage/v1/object/${BUCKET}/products/${orphanOld}`]);
  });

  it("updateProduct troca a imagem e remove o objeto ANTIGO (pós-commit)", async () => {
    const oldName = `${randomUUID()}.png`;
    const newName = `${randomUUID()}.png`;
    const { id, sku, name } = await seed(ownedUrl(oldName));

    const saved = await products.updateProduct(
      actor,
      id,
      input({ sku, name, imageUrl: ownedUrl(newName) }),
    );

    expect(saved.imageUrl).toBe(ownedUrl(newName));
    expect(deleted).toEqual([`${SUPA_URL}/storage/v1/object/${BUCKET}/products/${oldName}`]);
  });

  it("NÃO remove a imagem antiga se outro produto ainda a referencia", async () => {
    const shared = `${randomUUID()}.png`;
    const newName = `${randomUUID()}.png`;
    const p1 = await seed(ownedUrl(shared));
    await seed(ownedUrl(shared)); // segundo produto na MESMA imagem

    await products.updateProduct(
      actor,
      p1.id,
      input({ sku: p1.sku, name: p1.name, imageUrl: ownedUrl(newName) }),
    );

    expect(deleted).toEqual([]); // imagem ainda referenciada -> preservada
  });

  it("não remove nada em dry-run (só relatório)", async () => {
    const orphan = `${randomUUID()}.png`;
    const nowMs = Date.parse("2026-07-06T12:00:00Z");
    listRows = [
      { name: orphan, id: "1", created_at: new Date(nowMs - 48 * 3600_000).toISOString() },
    ];
    const report = await orphans.reconcileOrphanProductImages({ nowMs, dryRun: true });
    expect(report.orphans).toBe(1);
    expect(report.deleted).toBe(0);
    expect(deleted).toEqual([]);
  });
});

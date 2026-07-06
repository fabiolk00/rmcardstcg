import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteOwnedObject,
  deleteOwnedObjectByUrl,
  listOwnedObjects,
  parseOwnedObjectPath,
  selectOrphanPaths,
  type OwnedStorageObject,
} from "../../lib/services/supabase/storage";

/**
 * Cleanup de imagens órfãs — provas DB-free (parse/delete/list + seleção pura).
 * A orquestração que toca o banco (reconcile completo, cleanup no updateProduct) é
 * coberta por tests/storage/reconcile-db.test.ts, opt-in via TEST_DATABASE_URL.
 */

const SUPA_URL = "https://proj.supabase.co";
const BUCKET = "tcg";
const publicPrefix = `${SUPA_URL}/storage/v1/object/public/${BUCKET}/`;
const ownedUrl = (name: string) => `${publicPrefix}products/${name}`;

function setStorageEnv() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPA_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  delete process.env.SUPABASE_STORAGE_BUCKET; // default "tcg"
}

// --- parseOwnedObjectPath: a guarda que impede tocar no que não é nosso ----------

describe("orphan-cleanup — parseOwnedObjectPath", () => {
  beforeEach(setStorageEnv);

  it("extrai o object-path de uma URL do NOSSO bucket/prefixo", () => {
    expect(parseOwnedObjectPath(ownedUrl("a1b2.png"))).toBe("products/a1b2.png");
  });

  it("ignora o placeholder local, URLs externas e outro bucket", () => {
    expect(parseOwnedObjectPath("/products/placeholder.svg")).toBeNull();
    expect(parseOwnedObjectPath("https://evil.example/x.png")).toBeNull();
    expect(
      parseOwnedObjectPath(`${SUPA_URL}/storage/v1/object/public/outro/products/x.png`),
    ).toBeNull();
  });

  it("recusa path traversal e conteúdo fora do prefixo products/", () => {
    expect(parseOwnedObjectPath(`${publicPrefix}products/../secret.png`)).toBeNull();
    expect(parseOwnedObjectPath(`${publicPrefix}avatars/x.png`)).toBeNull();
  });

  it("retorna null quando o Storage não está configurado", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(parseOwnedObjectPath(ownedUrl("a.png"))).toBeNull();
  });
});

// --- deleteOwnedObject / ByUrl: best-effort, idempotente, nunca lança ------------

describe("orphan-cleanup — remoção best-effort", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setStorageEnv();
    fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("emite DELETE no objeto correto e reporta 'deleted'", async () => {
    const outcome = await deleteOwnedObjectByUrl(ownedUrl("uuid.png"));
    expect(outcome).toBe("deleted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SUPA_URL}/storage/v1/object/${BUCKET}/products/uuid.png`);
    expect(init.method).toBe("DELETE");
  });

  it("não toca em URL não-nossa (skipped, sem rede)", async () => {
    expect(await deleteOwnedObjectByUrl("/products/placeholder.svg")).toBe("skipped");
    expect(await deleteOwnedObjectByUrl("https://evil.example/x.png")).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 conta como removido (idempotência do cleanup)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response);
    expect(await deleteOwnedObject("products/gone.png")).toBe("deleted");
  });

  it("falha de rede vira 'failed' e NUNCA lança", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(deleteOwnedObject("products/x.png")).resolves.toBe("failed");
  });

  it("HTTP 500 vira 'failed' (fica para a próxima varredura)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);
    expect(await deleteOwnedObject("products/x.png")).toBe("failed");
  });
});

// --- listOwnedObjects: reconstrói products/<name>, filtra pastas/placeholder -----

describe("orphan-cleanup — listOwnedObjects", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setStorageEnv();
    vi.stubGlobal(
      "fetch",
      (fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { name: "a.png", id: "1", created_at: "2026-01-01T00:00:00Z" },
          { name: "subpasta", id: null }, // pasta -> ignorada
          { name: ".emptyFolderPlaceholder", id: "z" }, // placeholder -> ignorado
          { name: "b.webp", id: "2", created_at: null }, // sem data -> 0
        ],
        text: async () => "",
      })) as unknown as ReturnType<typeof vi.fn>),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("devolve só objetos reais, com path e createdAtMs", async () => {
    const objs = await listOwnedObjects();
    expect(objs).toEqual<OwnedStorageObject[]>([
      { path: "products/a.png", createdAtMs: Date.parse("2026-01-01T00:00:00Z") },
      { path: "products/b.webp", createdAtMs: 0 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 4 < pageSize -> uma página só
  });
});

// --- selectOrphanPaths: seleção pura, determinística, idempotente ---------------

describe("orphan-cleanup — selectOrphanPaths (pura)", () => {
  const NOW = Date.parse("2026-07-06T12:00:00Z");
  const GRACE = 24 * 60 * 60 * 1000;
  const old = NOW - 48 * 60 * 60 * 1000; // 2 dias -> fora da carência
  const recent = NOW - 1 * 60 * 60 * 1000; // 1h -> protegido

  const objects: OwnedStorageObject[] = [
    { path: "products/ref.png", createdAtMs: old }, // referenciado
    { path: "products/orphan-old.png", createdAtMs: old }, // ÓRFÃ removível
    { path: "products/orphan-new.png", createdAtMs: recent }, // órfã recente -> protegida
  ];
  const referenced = new Set(["products/ref.png"]);

  it("remove só o não-referenciado E fora da carência", () => {
    expect(selectOrphanPaths({ objects, referenced, nowMs: NOW, graceMs: GRACE })).toEqual([
      "products/orphan-old.png",
    ]);
  });

  it("protege uploads recentes (janela de carência)", () => {
    const all = selectOrphanPaths({ objects, referenced, nowMs: NOW, graceMs: 0 });
    expect(all).toContain("products/orphan-new.png"); // com carência 0, cai
  });

  it("é idempotente: sem os já-removidos, a próxima passada não acha nada", () => {
    const first = selectOrphanPaths({ objects, referenced, nowMs: NOW, graceMs: GRACE });
    const remaining = objects.filter((o) => !first.includes(o.path));
    expect(
      selectOrphanPaths({ objects: remaining, referenced, nowMs: NOW, graceMs: GRACE }),
    ).toEqual([]);
  });
});

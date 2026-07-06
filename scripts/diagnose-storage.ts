/**
 * Diagnóstico READ-ONLY do Storage x banco. Não apaga nada. Responde:
 *  - para QUAL projeto Supabase e bucket o ambiente aponta?
 *  - o bucket tem objetos? sob quais prefixos?
 *  - os produtos do banco apontam para URLs NOSSAS (que o cleanup reconhece)?
 *
 *   pnpm tsx scripts/diagnose-storage.ts
 */
export {}; // isola o escopo do script (senão `main` colide com outros scripts)

for (const file of [".env.local", ".env"]) {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(file);
  } catch {
    // ausente ou runtime sem loadEnvFile — segue com o env já presente
  }
}

type Row = { name: string; id: string | null; created_at?: string | null };

async function listPrefix(
  cfg: { url: string; serviceRoleKey: string; bucket: string },
  prefix: string,
): Promise<Row[]> {
  const res = await fetch(`${cfg.url}/storage/v1/object/list/${cfg.bucket}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      apikey: cfg.serviceRoleKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prefix,
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`list("${prefix}") -> HTTP ${res.status}. ${text}`);
  }
  return (await res.json()) as Row[];
}

async function main(): Promise<number> {
  const { getSupabaseStorageConfig, isSupabaseStorageConfigured } =
    await import("../lib/services/supabase/config");
  const { parseOwnedObjectPath } = await import("../lib/services/supabase/storage");
  const { prisma } = await import("../lib/db");

  if (!isSupabaseStorageConfigured()) {
    console.error("[diag] Storage NÃO configurado neste ambiente (faltam envs).");
    return 1;
  }
  const cfg = getSupabaseStorageConfig();
  const host = new URL(cfg.url).host;
  const dbHost = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? "").host;
    } catch {
      return "(DATABASE_URL ausente/inválida)";
    }
  })();

  console.log("[diag] Ambiente que o script está usando:");
  console.log(`       Supabase projeto : ${host}`);
  console.log(`       bucket           : ${cfg.bucket}`);
  console.log(`       banco (host)     : ${dbHost}`);

  try {
    const root = await listPrefix(cfg, "");
    console.log(`\n[diag] Raiz do bucket "${cfg.bucket}" — ${root.length} entrada(s):`);
    for (const r of root.slice(0, 20)) {
      console.log(`       - ${r.name}${r.id ? "" : "/ (pasta)"}`);
    }

    const prods = await listPrefix(cfg, "products");
    const files = prods.filter((r) => r.id && r.name !== ".emptyFolderPlaceholder");
    console.log(`\n[diag] Objetos sob "products/": ${files.length}`);
    for (const r of files.slice(0, 10)) console.log(`       - products/${r.name}`);

    const total = await prisma.product.count();
    const sample = await prisma.product.findMany({
      select: { name: true, imageUrl: true },
      take: 20,
      orderBy: { createdAt: "desc" },
    });
    const owned = sample.filter((p) => parseOwnedObjectPath(p.imageUrl)).length;
    console.log(`\n[diag] Produtos no banco: ${total} (amostra de ${sample.length})`);
    console.log(`       apontando para URL NOSSA (reconhecida pelo cleanup): ${owned}`);
    for (const p of sample.slice(0, 8)) {
      const owns = parseOwnedObjectPath(p.imageUrl) ? "OURS " : "outra";
      console.log(`       [${owns}] ${p.name}: ${p.imageUrl}`);
    }

    console.log(
      "\n[diag] Leitura: se 'produtos no banco' e 'objetos sob products/' forem 0, este é um " +
        "ambiente vazio/dev — aponte DATABASE_URL + envs do Supabase para PROD para ver o real.",
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[diag] erro:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

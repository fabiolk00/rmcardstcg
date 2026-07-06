/**
 * Varredura MANUAL de imagens órfãs no Supabase Storage (bucket dos produtos).
 *
 * Órfã = objeto em `products/` que NENHUM produto referencia mais (troca de foto
 * antiga, upload que nunca virou produto, etc.) e mais velho que a carência de 24h.
 *
 *   pnpm tsx scripts/reconcile-storage-orphans.ts            # DRY-RUN (só relatório)
 *   pnpm tsx scripts/reconcile-storage-orphans.ts --apply    # remove de fato
 *
 * Seguro por padrão: sem --apply nada é removido. Idempotente: rodar de novo após um
 * --apply não encontra mais nada. Precisa de DATABASE_URL + NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY no ambiente (carregados de .env.local/.env se existirem).
 */
export {}; // isola o escopo do script (senão `main` colide com outros scripts)

// Node 20.12+: carrega envs de arquivo para o processo (scripts tsx não passam pelo
// Next, que normalmente injeta .env.local). Silencioso se o arquivo não existir.
for (const file of [".env.local", ".env"]) {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(file);
  } catch {
    // arquivo ausente ou runtime sem loadEnvFile — segue com o env já presente
  }
}

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");

  const { prisma } = await import("../lib/db");
  const { reconcileOrphanProductImages } = await import("../lib/services/supabase/orphans");
  const { isSupabaseStorageConfigured } = await import("../lib/services/supabase/config");

  if (!isSupabaseStorageConfigured()) {
    console.error(
      "[reconcile] Storage não configurado — defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.",
    );
    return 1;
  }

  console.log(`[reconcile] ${apply ? "APLICANDO (remove órfãs)" : "DRY-RUN (só relatório)"}…`);
  try {
    const report = await reconcileOrphanProductImages({ dryRun: !apply });
    console.log("[reconcile] relatório:", JSON.stringify(report, null, 2));
    if (!apply && report.orphans > 0) {
      console.log(
        `[reconcile] ${report.orphans} órfã(s) removível(is). Rode com --apply para remover.`,
      );
    }
    if (report.failed > 0) {
      console.warn(
        `[reconcile] ${report.failed} remoção(ões) falharam — serão revistas na próxima varredura.`,
      );
    }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[reconcile] erro:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

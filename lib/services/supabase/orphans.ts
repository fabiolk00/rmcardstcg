import { prisma } from "../../db";
import { isSupabaseStorageConfigured } from "./config";
import {
  deleteOwnedObject,
  listOwnedObjects,
  parseOwnedObjectPath,
  selectOrphanPaths,
} from "./storage";

/**
 * Cleanup de imagens órfãs no Supabase Storage.
 *
 * Duas frentes:
 *  1) PREVENT (cleanupReplacedImage): ao trocar a imagem de um produto, remove o
 *     objeto ANTIGO do bucket — chamado PÓS-COMMIT pela updateProduct, best-effort.
 *  2) RECONCILE (reconcileOrphanProductImages): varre o bucket e remove objetos que
 *     NENHUM produto referencia mais (as órfãs que já existem). Manual/ops.
 *
 * O Storage não é transacional com o Postgres, então nada aqui é "atômico" com o
 * banco: a fonte de verdade é sempre o `imageUrl` das linhas de products. Um objeto
 * só é removido quando comprovadamente não referenciado.
 */

/**
 * Janela de carência (24h): um objeto recém-enviado mas ainda NÃO salvo em nenhum
 * produto (upload feito, admin ainda não clicou salvar) parece órfão. Não removemos
 * objetos mais novos que isto para não apagar um upload em voo.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export type ReconcileReport = {
  /** false quando o Storage não está configurado (nada foi varrido). */
  configured: boolean;
  /** objetos existentes no bucket sob products/. */
  scanned: number;
  /** paths distintos referenciados por algum produto. */
  referenced: number;
  /** não-referenciados E fora da carência (candidatos a remover). */
  orphans: number;
  /** efetivamente removidos (ou que já não existiam). */
  deleted: number;
  /** falhas de remoção (ficam para a próxima varredura). */
  failed: number;
  /** não-referenciados porém RECENTES (protegidos pela carência). */
  skippedRecent: number;
  /** true quando nada foi de fato removido (só relatório). */
  dryRun: boolean;
};

/**
 * PREVENT: remove o objeto de uma imagem que acabou de ser substituída. Só remove se
 * NENHUM produto ainda aponta para aquela URL (evita apagar uma imagem compartilhada
 * por dois produtos — caso raro/manual). Best-effort: nunca lança.
 */
export async function cleanupReplacedImage(oldImageUrl: string): Promise<void> {
  const objectPath = parseOwnedObjectPath(oldImageUrl);
  if (!objectPath) return; // placeholder, URL externa, ou Storage não configurado
  // Neste ponto (pós-commit) o produto editado já aponta para a URL NOVA; um count > 0
  // significa que OUTRO produto ainda usa a antiga -> preservar.
  const stillUsed = await prisma.product.count({ where: { imageUrl: oldImageUrl } });
  if (stillUsed > 0) return;
  await deleteOwnedObject(objectPath);
}

/**
 * RECONCILE: varre o bucket, cruza com os imageUrl de products e remove as órfãs
 * (não referenciadas + fora da carência). Idempotente. `dryRun` só relata.
 */
export async function reconcileOrphanProductImages(opts?: {
  dryRun?: boolean;
  nowMs?: number;
  graceMs?: number;
}): Promise<ReconcileReport> {
  const dryRun = opts?.dryRun ?? false;
  const empty: ReconcileReport = {
    configured: false,
    scanned: 0,
    referenced: 0,
    orphans: 0,
    deleted: 0,
    failed: 0,
    skippedRecent: 0,
    dryRun,
  };
  if (!isSupabaseStorageConfigured()) return empty;

  const nowMs = opts?.nowMs ?? Date.now();
  const graceMs = opts?.graceMs ?? ORPHAN_GRACE_MS;

  const objects = await listOwnedObjects();

  // Conjunto de paths referenciados por QUALQUER produto (só os nossos; placeholder e
  // URLs externas caem fora via parseOwnedObjectPath).
  const rows = await prisma.product.findMany({ select: { imageUrl: true } });
  const referenced = new Set<string>();
  for (const r of rows) {
    const p = parseOwnedObjectPath(r.imageUrl);
    if (p) referenced.add(p);
  }

  const orphanPaths = selectOrphanPaths({ objects, referenced, nowMs, graceMs });
  const unreferenced = objects.filter((o) => !referenced.has(o.path)).length;
  const skippedRecent = unreferenced - orphanPaths.length;

  let deleted = 0;
  let failed = 0;
  if (!dryRun) {
    for (const path of orphanPaths) {
      const outcome = await deleteOwnedObject(path);
      if (outcome === "deleted") deleted += 1;
      else failed += 1;
    }
  }

  return {
    configured: true,
    scanned: objects.length,
    referenced: referenced.size,
    orphans: orphanPaths.length,
    deleted,
    failed,
    skippedRecent,
    dryRun,
  };
}

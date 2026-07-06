import { randomUUID } from "node:crypto";

import { getSupabaseStorageConfig, isSupabaseStorageConfigured } from "./config";

/**
 * Cliente de upload do Supabase Storage (REST direto via fetch — mesmo estilo do
 * client do Asaas, sem adicionar SDK). Sobe os bytes de uma imagem de produto e
 * devolve a URL publica do bucket.
 */
export class SupabaseStorageError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SupabaseStorageError";
    this.status = status;
  }
}

// Tipos de imagem aceitos -> extensao gravada no arquivo. A allowlist e a fonte de
// verdade da validacao de formato (a checagem no client e so dica de UX).
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Teto de tamanho da imagem (4 MB) — abaixo do limite de corpo da serverless (4,5 MB). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const UPLOAD_TIMEOUT_MS = 20_000;
// Subpasta dentro do bucket (organiza os objetos; nao e exigido pelo Storage).
const OBJECT_PREFIX = "products";

/** true se o content-type esta na allowlist de imagem aceita. */
export function isAcceptedImageType(contentType: string): boolean {
  return contentType in CONTENT_TYPE_EXT;
}

/**
 * SNIFFER de tipo por MAGIC BYTES — a FONTE DE VERDADE do formato no servidor.
 *
 * O content-type reivindicado (file.type) e controlado pelo CLIENTE e trivial de
 * forjar: um .exe/.php/.sh/.svg enviado com `Content-Type: image/jpeg` passaria na
 * allowlist baseada em header. Aqui olhamos os PRIMEIROS BYTES reais do arquivo; se
 * nao baterem com um formato de imagem aceito, rejeitamos. Defense-in-depth, zero
 * dependencia nova (mesma filosofia do resto do modulo — sem SDK).
 *
 * Assinaturas (allowlist):
 *  - PNG   89 50 4E 47 0D 0A 1A 0A
 *  - JPEG  FF D8 FF
 *  - GIF   "GIF87a" | "GIF89a"
 *  - WEBP  bytes 0-3 = "RIFF" e bytes 8-11 = "WEBP"
 *
 * SVG NAO tem magic bytes (e XML/texto) e por isso nunca e detectado — exatamente o
 * que queremos: SVG fica fora da allowlist e nao pode carregar <script>/onload.
 */
export function sniffImageType(fileBytes: ArrayBuffer): string | null {
  const b = new Uint8Array(fileBytes);
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 6 &&
    b[0] === 0x47 && // G
    b[1] === 0x49 && // I
    b[2] === 0x46 && // F
    b[3] === 0x38 && // 8
    (b[4] === 0x37 || b[4] === 0x39) && // 7 | 9
    b[5] === 0x61 // a
  ) {
    return "image/gif";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && // R
    b[1] === 0x49 && // I
    b[2] === 0x46 && // F
    b[3] === 0x46 && // F
    b[8] === 0x57 && // W
    b[9] === 0x45 && // E
    b[10] === 0x42 && // B
    b[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Sobe os bytes de uma imagem para o bucket e devolve a URL publica.
 *
 * O nome do arquivo e GERADO no servidor (uuid) — nunca confia no nome do cliente
 * (evita overwrite de objeto e path traversal). Bucket publico: a URL e estavel,
 * cacheavel e nao precisa ser assinada. x-upsert=false porque o uuid nao colide.
 */
export async function uploadProductImage(
  fileBytes: ArrayBuffer,
  contentType: string,
): Promise<string> {
  const ext = CONTENT_TYPE_EXT[contentType];
  if (!ext) {
    throw new SupabaseStorageError("Tipo de imagem nao suportado.", 415);
  }

  // GATE de conteudo (nao de header): os bytes reais precisam bater com o tipo
  // reivindicado. Fecha o buraco de MIME spoofing (exe/php/svg/zip disfarcado de
  // imagem) e falha FECHADO antes de qualquer round-trip de rede.
  const detected = sniffImageType(fileBytes);
  if (detected !== contentType) {
    throw new SupabaseStorageError("Conteudo do arquivo nao corresponde a uma imagem valida.", 415);
  }

  const { url, serviceRoleKey, bucket } = getSupabaseStorageConfig();
  const objectPath = `${OBJECT_PREFIX}/${randomUUID()}.${ext}`;

  let res: Response;
  try {
    res = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
      method: "POST",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": contentType,
        "Cache-Control": "max-age=31536000",
        "x-upsert": "false",
      },
      body: fileBytes,
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new SupabaseStorageError("Tempo de envio da imagem esgotado.", 504);
    }
    throw new SupabaseStorageError("Falha de conexao com o Storage.", 502);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `Storage respondeu ${res.status}.`;
    try {
      const body = JSON.parse(text) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // corpo nao-JSON: mantem a mensagem generica com o status
    }
    throw new SupabaseStorageError(message, res.status);
  }

  return `${url}/storage/v1/object/public/${bucket}/${objectPath}`;
}

// ---------------------------------------------------------------------------
// Remoção de objetos (prevent-orphans + reconcile). O Storage é um object store
// separado do Postgres — NÃO há transação atômica entre os dois. A estratégia é
// best-effort PÓS-COMMIT: uma falha aqui deixa no máximo um órfão (varrido depois
// pelo reconcile), nunca corrompe o save. Por isso `deleteOwnedObject` NUNCA lança.
// ---------------------------------------------------------------------------

/** Um objeto do bucket que ESTE módulo criou, com seu instante de criação. */
export type OwnedStorageObject = { path: string; createdAtMs: number };

/** Resultado de uma remoção best-effort. */
export type StorageDeleteOutcome = "deleted" | "skipped" | "failed";

type SupabaseListRow = {
  name: string;
  // Objetos reais têm id != null; "subpastas" no list vêm com id null.
  id: string | null;
  created_at?: string | null;
};

/**
 * Extrai o object-path (`products/<uuid>.<ext>`) de uma URL pública SE ela pertence
 * ao NOSSO bucket e prefixo. Devolve null para: placeholder local, URL externa,
 * bucket diferente, ou Storage não configurado. É a guarda que impede o cleanup de
 * tocar em qualquer coisa que não tenhamos criado.
 */
export function parseOwnedObjectPath(publicUrl: string): string | null {
  if (!publicUrl || !isSupabaseStorageConfigured()) return null;
  const { url, bucket } = getSupabaseStorageConfig();
  const prefix = `${url}/storage/v1/object/public/${bucket}/`;
  if (!publicUrl.startsWith(prefix)) return null;
  const objectPath = publicUrl.slice(prefix.length);
  // Só objetos no nosso prefixo (`products/`), e nunca com escape sequences.
  if (!objectPath.startsWith(`${OBJECT_PREFIX}/`)) return null;
  if (objectPath.includes("..")) return null;
  return objectPath;
}

/** Remove um objeto pelo path. Best-effort: 404 conta como removido (idempotente); nunca lança. */
export async function deleteOwnedObject(objectPath: string): Promise<StorageDeleteOutcome> {
  if (!isSupabaseStorageConfigured()) return "skipped";
  const { url, serviceRoleKey, bucket } = getSupabaseStorageConfig();
  try {
    const res = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey },
      cache: "no-store",
    });
    // 404 = já não existe -> tratamos como sucesso (idempotência do cleanup).
    return res.ok || res.status === 404 ? "deleted" : "failed";
  } catch {
    return "failed";
  }
}

/** Remove pelo URL público, mas só se for um objeto NOSSO (senão "skipped"). Nunca lança. */
export async function deleteOwnedObjectByUrl(publicUrl: string): Promise<StorageDeleteOutcome> {
  const objectPath = parseOwnedObjectPath(publicUrl);
  if (!objectPath) return "skipped";
  return deleteOwnedObject(objectPath);
}

/**
 * Lista TODOS os objetos sob o prefixo `products/` no bucket (paginado). Usado pelo
 * reconcile p/ cruzar contra as URLs referenciadas no banco. Lança em erro de rede/HTTP
 * (o reconcile decide o que fazer) — diferente do delete, que é best-effort.
 */
export async function listOwnedObjects(): Promise<OwnedStorageObject[]> {
  const { url, serviceRoleKey, bucket } = getSupabaseStorageConfig();
  const out: OwnedStorageObject[] = [];
  const pageSize = 100;
  let offset = 0;

  for (;;) {
    const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix: OBJECT_PREFIX,
        limit: pageSize,
        offset,
        sortBy: { column: "name", order: "asc" },
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SupabaseStorageError(
        `Storage list respondeu ${res.status}. ${text}`.trim(),
        res.status,
      );
    }

    const rows = (await res.json()) as SupabaseListRow[];
    for (const r of rows) {
      if (!r.id) continue; // subpasta, não objeto
      if (r.name === ".emptyFolderPlaceholder") continue;
      out.push({
        path: `${OBJECT_PREFIX}/${r.name}`,
        createdAtMs: r.created_at ? Date.parse(r.created_at) : 0,
      });
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

/**
 * Seleção PURA das órfãs: objetos não referenciados por nenhum produto E mais velhos
 * que a carência. Sem banco/rede — determinística e testável. Idempotente por
 * construção: rode de novo sem os já-removidos e o resultado é []. (Vive aqui, e não
 * em orphans.ts, para ficar livre do import de Prisma e poder ser testada DB-free.)
 */
export function selectOrphanPaths(params: {
  objects: OwnedStorageObject[];
  referenced: Set<string>;
  nowMs: number;
  graceMs: number;
}): string[] {
  const { objects, referenced, nowMs, graceMs } = params;
  return objects
    .filter((o) => !referenced.has(o.path))
    .filter((o) => nowMs - o.createdAtMs >= graceMs)
    .map((o) => o.path);
}

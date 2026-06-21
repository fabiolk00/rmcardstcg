import { randomUUID } from "node:crypto";

import { getSupabaseStorageConfig } from "./config";

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

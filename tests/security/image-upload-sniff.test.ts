import { describe, expect, it } from "vitest";

import {
  SupabaseStorageError,
  isAcceptedImageType,
  sniffImageType,
  uploadProductImage,
} from "../../lib/services/supabase/storage";

// Magic bytes minimos de cada formato aceito.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
// "RIFF"...."WEBP"
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
// HTML mascarado de imagem (vetor de stored-XSS/hosting no bucket publico).
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");

describe("sniffImageType — assinatura pelos bytes reais", () => {
  it("detecta cada formato aceito pela magic number", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("rejeita conteudo que nao e imagem (mesmo curto)", () => {
    expect(sniffImageType(HTML)).toBeNull();
    expect(sniffImageType(new Uint8Array([0x00, 0x01]))).toBeNull();
  });

  it("isAcceptedImageType cobre a mesma allowlist", () => {
    expect(isAcceptedImageType("image/png")).toBe(true);
    expect(isAcceptedImageType("text/html")).toBe(false);
  });
});

describe("uploadProductImage — content-type forjado", () => {
  it("recusa bytes de HTML declarados como image/png ANTES de qualquer upload", async () => {
    // O sniff roda antes de ler config/rede: o spoof falha sem tocar no Storage.
    await expect(uploadProductImage(HTML.buffer as ArrayBuffer, "image/png")).rejects.toMatchObject({
      status: 415,
    });
    await expect(
      uploadProductImage(HTML.buffer as ArrayBuffer, "image/png"),
    ).rejects.toBeInstanceOf(SupabaseStorageError);
  });

  it("recusa tipo declarado fora da allowlist", async () => {
    await expect(
      uploadProductImage(PNG.buffer as ArrayBuffer, "image/svg+xml"),
    ).rejects.toMatchObject({ status: 415 });
  });
});

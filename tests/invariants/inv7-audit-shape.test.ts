import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Sondas de FORMA (estaticas, sem banco) para o INV-7 — auditoria imutavel.
 *
 * INV-7 exige:
 *  (a) writeAuditLog recebe o `tx` da transacao, nunca o `prisma` global.
 *  (b) TODA mutacao de admin chama writeAuditLog (nenhuma action perde o call).
 *  (c) before/after sao COERENTES: o `before` refere o estado PRE-mutacao,
 *      o `after` o estado POS-mutacao. before != after quando algo muda.
 *
 * Defeitos alvo desta suite:
 *  D-01 coupons.ts setCouponActive:   writeAuditLog(prisma, ...) — usa cliente global.
 *  D-02 orders.ts  updateOrderInternalNote: nao chama writeAuditLog apos o UPDATE.
 *  D-03 products.ts updateProduct:    before: auditSnapshot(product) onde `product`
 *                                     e o snapshot POS-mutacao — before == after.
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("INV-7 (forma) — auditoria imutavel", () => {
  // ------------------------------------------------------------------
  // D-01: setCouponActive passa `prisma` (global, autocommit) em vez de `tx`
  // ------------------------------------------------------------------
  it("D-01: writeAuditLog em setCouponActive recebe tx, nunca o prisma global", () => {
    const src = read("lib/data/coupons.ts");

    // Extrai o corpo da funcao setCouponActive
    const fn = /export async function setCouponActive[\s\S]*?\n\}/.exec(src);
    expect(fn, "nao encontrei setCouponActive em lib/data/coupons.ts").not.toBe(null);
    const body = fn![0];

    // Deve haver exatamente UMA chamada writeAuditLog
    const calls = (body.match(/writeAuditLog\s*\(/g) ?? []).length;
    expect(calls, "setCouponActive deve ter exatamente 1 chamada writeAuditLog").toBe(1);

    // O primeiro argumento de writeAuditLog NAO pode ser `prisma` (global)
    const offending = /writeAuditLog\s*\(\s*prisma\b/.test(body);
    expect(
      offending,
      "D-01 CONFIRMADO: setCouponActive chama writeAuditLog(prisma, ...) — usa o cliente global (autocommit) em vez de tx; se a transacao fizer rollback o audit_log persiste orfao (INV-7)",
    ).toBe(false);
  });

  // ------------------------------------------------------------------
  // D-02: updateOrderInternalNote mutaciona o pedido mas nao grava audit_log
  // ------------------------------------------------------------------
  it("D-02: updateOrderInternalNote chama writeAuditLog na mesma transacao", () => {
    const src = read("lib/data/orders.ts");

    // Localiza a posicao de inicio de updateOrderInternalNote e
    // extrai ate a proxima funcao exportada (export async function ...)
    // para nao depender da forma exata do fechamento de chaves.
    const startIdx = src.indexOf("export async function updateOrderInternalNote");
    expect(startIdx, "nao encontrei updateOrderInternalNote em lib/data/orders.ts").toBeGreaterThan(
      -1,
    );

    // Proximo `export` apos o inicio da funcao
    const nextExport = src.indexOf("\nexport ", startIdx + 1);
    const body = nextExport === -1 ? src.slice(startIdx) : src.slice(startIdx, nextExport);

    const hasAuditCall = /writeAuditLog\s*\(/.test(body);
    expect(
      hasAuditCall,
      "D-02 CONFIRMADO: updateOrderInternalNote muta internalNote via tx.order.update mas nao chama writeAuditLog — mutacao admin sem rastro de auditoria (INV-7)",
    ).toBe(true);
  });

  // ------------------------------------------------------------------
  // D-03: updateProduct passa o snapshot POS-mutacao como `before`
  //   (before: auditSnapshot(product) onde `product` e toProduct(row) — o row
  //    retornado pelo UPDATE, logo POS-mutacao; before e after ficam identicos)
  // ------------------------------------------------------------------
  it("D-03: updateProduct usa snapshot PRE-mutacao em before (before != after)", () => {
    const src = read("lib/data/products.ts");

    // Extrai o corpo de updateProduct
    const fn = /export async function updateProduct[\s\S]*?\n\}/.exec(src);
    expect(fn, "nao encontrei updateProduct em lib/data/products.ts").not.toBe(null);
    const body = fn![0];

    // O `before` deve ser capturado ANTES do tx.product.update (deve referenciar
    // a variavel `before`, que e toProduct(current) — o row lido PRE-update).
    // O defeito e passar auditSnapshot(product) tanto em before quanto em after,
    // onde `product` e o resultado do UPDATE (pos-mutacao).

    // Verifica que ha uma variavel `before` sendo criada antes do update
    const hasBeforeVar = /const before\s*=\s*toProduct\s*\(current\)/.test(body);
    expect(
      hasBeforeVar,
      "updateProduct nao cria a variavel `before` a partir do estado pre-mutacao (current) — necessario para before != after (INV-7)",
    ).toBe(true);

    // Extrai o bloco writeAuditLog dentro de updateProduct
    const auditBlock = /await writeAuditLog\s*\(tx,\s*\{[\s\S]*?\}\s*\)/.exec(body);
    expect(auditBlock, "updateProduct nao tem chamada writeAuditLog").not.toBe(null);
    const auditCall = auditBlock![0];

    // O campo `before:` do audit deve referenciar a variavel `before` (pre-mutacao),
    // nao `auditSnapshot(product)` onde `product` e o pos-mutacao.
    // Padrao do defeito: before: auditSnapshot(product) — mesmo argumento do after.
    const offendingBefore = /before\s*:\s*auditSnapshot\s*\(\s*product\s*\)/.test(auditCall);
    expect(
      offendingBefore,
      "D-03 CONFIRMADO: updateProduct passa auditSnapshot(product) como `before`, mas `product` e o snapshot POS-mutacao (toProduct do UPDATE); before e after ficam identicos — o historico de auditoria nao registra o estado anterior (INV-7)",
    ).toBe(false);

    // O campo `before:` deve usar a variavel `before` (snapshot pre-mutacao)
    const correctBefore = /before\s*:\s*auditSnapshot\s*\(\s*before\s*\)/.test(auditCall);
    expect(
      correctBefore,
      "updateProduct nao usa `auditSnapshot(before)` no campo before do writeAuditLog — o estado pre-mutacao nao esta sendo registrado corretamente (INV-7)",
    ).toBe(true);
  });

  // ------------------------------------------------------------------
  // Enumeracao completa: toda mutacao de admin tem writeAuditLog
  // ------------------------------------------------------------------
  it("toda mutacao admin de produto tem writeAuditLog (createProduct, updateProduct, setProductActive)", () => {
    const src = read("lib/data/products.ts");
    for (const fn of ["createProduct", "updateProduct", "setProductActive"]) {
      const body = new RegExp(`export async function ${fn}[\\s\\S]*?\\n\\}`).exec(src);
      expect(body, `nao encontrei ${fn} em lib/data/products.ts`).not.toBe(null);
      expect(
        /writeAuditLog\s*\(/.test(body![0]),
        `${fn} nao chama writeAuditLog — mutacao sem trilha (INV-7)`,
      ).toBe(true);
    }
  });

  it("toda mutacao admin de cupom tem writeAuditLog (createCoupon, updateCoupon, setCouponActive, deleteCoupon)", () => {
    const src = read("lib/data/coupons.ts");
    for (const fn of ["createCoupon", "updateCoupon", "setCouponActive", "deleteCoupon"]) {
      const body = new RegExp(`export async function ${fn}[\\s\\S]*?\\n\\}`).exec(src);
      expect(body, `nao encontrei ${fn} em lib/data/coupons.ts`).not.toBe(null);
      expect(
        /writeAuditLog\s*\(/.test(body![0]),
        `${fn} nao chama writeAuditLog — mutacao sem trilha (INV-7)`,
      ).toBe(true);
    }
  });

  it("toda mutacao admin de pedido tem writeAuditLog (updateOrderShippingStatus, updateOrderInternalNote, adjustOrderPaymentStatus)", () => {
    const src = read("lib/data/orders.ts");
    for (const fn of [
      "updateOrderShippingStatus",
      "updateOrderInternalNote",
      "adjustOrderPaymentStatus",
    ]) {
      const startIdx = src.indexOf(`export async function ${fn}`);
      expect(startIdx, `nao encontrei ${fn} em lib/data/orders.ts`).toBeGreaterThan(-1);
      const nextExport = src.indexOf("\nexport ", startIdx + 1);
      const body = nextExport === -1 ? src.slice(startIdx) : src.slice(startIdx, nextExport);
      expect(
        /writeAuditLog\s*\(/.test(body),
        `${fn} nao chama writeAuditLog — mutacao admin sem trilha de auditoria (INV-7)`,
      ).toBe(true);
    }
  });

  it("toda mutacao admin de usuario tem writeAuditLog (setUserRole)", () => {
    const src = read("lib/data/users.ts");
    const body = /export async function setUserRole[\s\S]*?\n\}/.exec(src);
    expect(body, "nao encontrei setUserRole em lib/data/users.ts").not.toBe(null);
    expect(/writeAuditLog\s*\(/.test(body![0]), "setUserRole nao chama writeAuditLog (INV-7)").toBe(
      true,
    );
  });
});

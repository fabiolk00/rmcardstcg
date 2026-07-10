import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do CRUD de categoria (createCategory/deleteCategory).
//  - criar categoria grava audit_log category.create.
//  - excluir categoria SEM dependentes (catalogo desacoplado, sem FK) remove a
//    linha e grava audit_log category.delete com before=snapshot/after=null.
//  - nome duplicado (case-insensitive) na criacao retorna { ok:false } com
//    mensagem amigavel, sem lancar excecao nao tratada.
// Opt-in via TEST_DATABASE_URL (igual as demais suites de DB).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ACTOR = { clerkUserId: null, email: null, role: null };

describe.skipIf(!TEST_DATABASE_URL)("categories CRUD", () => {
  let prisma: any;
  let categories: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = (await import("../../lib/db")).prisma;
    categories = await import("../../lib/data/categories");
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  it("cria categoria e grava audit_log category.create", async () => {
    const name = `Categoria ${randomUUID().slice(0, 8)}`;

    const result = await categories.createCategory(ACTOR, { name, description: "Uma descrição" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await prisma.category.findUnique({ where: { id: result.category.id } });
    expect(row).not.toBeNull();
    expect(row.name).toBe(name);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "category", entityId: result.category.id, action: "category_create" },
    });
    expect(audit).not.toBeNull();
  });

  it("exclui categoria sem dependentes e grava audit_log category.delete", async () => {
    const name = `Categoria ${randomUUID().slice(0, 8)}`;
    const created = await categories.createCategory(ACTOR, { name, description: null });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await categories.deleteCategory(ACTOR, created.category.id);
    expect(result.ok).toBe(true);

    const stillThere = await prisma.category.findUnique({ where: { id: created.category.id } });
    expect(stillThere).toBeNull(); // removido de fato

    const audit = await prisma.auditLog.findFirst({
      where: {
        entityType: "category",
        entityId: created.category.id,
        action: "category_delete",
      },
    });
    expect(audit).not.toBeNull();
    expect(audit.before).toMatchObject({ name });
    expect(audit.after).toBeNull();
  });

  it("bloqueia nome duplicado (case-insensitive) com mensagem amigável", async () => {
    const name = `Categoria ${randomUUID().slice(0, 8)}`;
    const first = await categories.createCategory(ACTOR, { name, description: null });
    expect(first.ok).toBe(true);

    const second = await categories.createCategory(ACTOR, {
      name: name.toUpperCase(),
      description: null,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain(name.toUpperCase());
  });
});

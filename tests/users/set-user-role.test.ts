import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova da troca de role auditada (setUserRole — item #3 do AUDIT).
//  - promove/rebaixa e GRAVA audit_log (user.role_update; before/after corretos);
//  - bloqueia auto-alteracao (mesmo clerkUserId do ator) SEM gravar audit;
//  - usuario inexistente/soft-deleted => ok:false.
// Opt-in via TEST_DATABASE_URL (igual as demais suites de DB).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("setUserRole", () => {
  let prisma: any;
  let users: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    prisma = (await import("../../lib/db")).prisma;
    users = await import("../../lib/data/users");
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function seedUser(role: "cliente" | "admin"): Promise<string> {
    const clerkUserId = `u-${randomUUID().slice(0, 12)}`;
    await prisma.user.create({
      data: {
        clerkUserId,
        email: `${clerkUserId}@t.com`,
        name: "T",
        role,
      },
    });
    return clerkUserId;
  }

  // Ator distinto do alvo (admin agindo sobre outro usuario).
  const actorOf = (clerkUserId: string) => ({
    clerkUserId,
    email: `${clerkUserId}@t.com`,
    role: "admin" as const,
  });

  it("promove cliente -> admin e grava audit_log com before/after", async () => {
    const actorId = `a-${randomUUID().slice(0, 12)}`;
    const targetId = await seedUser("cliente");

    const result = await users.setUserRole(actorOf(actorId), targetId, "admin");
    expect(result.ok).toBe(true);
    expect(result.user.role).toBe("admin");

    const row = await prisma.user.findUnique({ where: { clerkUserId: targetId } });
    expect(row.role).toBe("admin");

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "user", entityId: targetId, action: "user_role_update" },
    });
    expect(audit).not.toBeNull();
    expect(audit.before).toEqual({ role: "cliente" });
    expect(audit.after).toEqual({ role: "admin" });
    expect(audit.actorClerkUserId).toBe(actorId);
  });

  it("rebaixa admin -> cliente e grava audit_log com before/after", async () => {
    const actorId = `a-${randomUUID().slice(0, 12)}`;
    const targetId = await seedUser("admin");

    const result = await users.setUserRole(actorOf(actorId), targetId, "cliente");
    expect(result.ok).toBe(true);
    expect(result.user.role).toBe("cliente");

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "user", entityId: targetId, action: "user_role_update" },
    });
    expect(audit.before).toEqual({ role: "admin" });
    expect(audit.after).toEqual({ role: "cliente" });
  });

  it("bloqueia alterar a PROPRIA role (anti-lockout) e NAO grava audit", async () => {
    const selfId = await seedUser("admin");

    const result = await users.setUserRole(actorOf(selfId), selfId, "cliente");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/própria role/i);

    // Role inalterada.
    const row = await prisma.user.findUnique({ where: { clerkUserId: selfId } });
    expect(row.role).toBe("admin");

    // Nenhuma linha de auditoria para a tentativa bloqueada.
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: "user", entityId: selfId, action: "user_role_update" },
    });
    expect(audit).toBeNull();
  });

  it("usuario inexistente => ok:false (Usuário não encontrado)", async () => {
    const actorId = `a-${randomUUID().slice(0, 12)}`;
    const result = await users.setUserRole(actorOf(actorId), `ghost-${randomUUID()}`, "admin");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/não encontrado/i);
  });

  it("usuario soft-deleted => ok:false (tratado como inexistente)", async () => {
    const actorId = `a-${randomUUID().slice(0, 12)}`;
    const targetId = await seedUser("cliente");
    await users.deleteUserByClerkId(targetId);

    const result = await users.setUserRole(actorOf(actorId), targetId, "admin");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/não encontrado/i);
  });
});

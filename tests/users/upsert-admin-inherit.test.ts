import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do AUTO-HEAL de admin por e-mail (upsertUserFromClerk item (3)): quando a
// conta e recriada no Clerk (clerk_user_id NOVO, mesma pessoa/e-mail), a nova linha
// HERDA admin de uma linha existente do mesmo e-mail — a role nao fica presa no id
// antigo. Cobre o mismatch de clerk_user_id sem depender de ADMIN_EMAILS.
// Opt-in via TEST_DATABASE_URL (igual as demais suites de DB).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("upsertUserFromClerk — auto-heal de admin por e-mail", () => {
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

  const email = () => `dup-${randomUUID().slice(0, 8)}@t.com`;
  const id = (p: string) => `u-${p}-${randomUUID().slice(0, 8)}`;

  it("id NOVO com e-mail de admin existente NASCE admin (troca de clerk_user_id)", async () => {
    const e = email();
    const oldId = id("old");
    const newId = id("new");

    // Linha antiga admin (conta anterior no Clerk).
    await prisma.user.create({ data: { clerkUserId: oldId, email: e, name: "Velho", role: "admin" } });

    // Webhook do id NOVO — e-mail NAO esta em ADMIN_EMAILS (emailIsAdmin: false).
    await users.upsertUserFromClerk({ clerkUserId: newId, email: e, name: "Novo", emailIsAdmin: false });

    const novo = await prisma.user.findUnique({ where: { clerkUserId: newId } });
    expect(novo.role).toBe("admin"); // herdou por e-mail
  });

  it("case-insensitive: e-mail com caixa diferente ainda herda admin", async () => {
    const e = email();
    const oldId = id("old");
    const newId = id("new");
    await prisma.user.create({
      data: { clerkUserId: oldId, email: e.toUpperCase(), name: null, role: "admin" },
    });

    await users.upsertUserFromClerk({ clerkUserId: newId, email: e, name: null, emailIsAdmin: false });

    const novo = await prisma.user.findUnique({ where: { clerkUserId: newId } });
    expect(novo.role).toBe("admin");
  });

  it("sibling admin SOFT-DELETED nao confere admin", async () => {
    const e = email();
    const oldId = id("old");
    const newId = id("new");
    await prisma.user.create({
      data: { clerkUserId: oldId, email: e, name: null, role: "admin", deletedAt: new Date() },
    });

    await users.upsertUserFromClerk({ clerkUserId: newId, email: e, name: null, emailIsAdmin: false });

    const novo = await prisma.user.findUnique({ where: { clerkUserId: newId } });
    expect(novo.role).toBe("cliente"); // deletado nao conta como sibling
  });

  it("sem sibling admin e sem ADMIN_EMAILS => cliente (comportamento padrao)", async () => {
    const newId = id("solo");
    await users.upsertUserFromClerk({
      clerkUserId: newId,
      email: email(),
      name: null,
      emailIsAdmin: false,
    });
    const row = await prisma.user.findUnique({ where: { clerkUserId: newId } });
    expect(row.role).toBe("cliente");
  });

  it("sibling apenas CLIENTE nao promove (so admin herda)", async () => {
    const e = email();
    await prisma.user.create({ data: { clerkUserId: id("old"), email: e, name: null, role: "cliente" } });
    const newId = id("new");
    await users.upsertUserFromClerk({ clerkUserId: newId, email: e, name: null, emailIsAdmin: false });
    const novo = await prisma.user.findUnique({ where: { clerkUserId: newId } });
    expect(novo.role).toBe("cliente");
  });
});

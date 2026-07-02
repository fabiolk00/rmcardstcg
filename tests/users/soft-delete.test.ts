import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Prova do soft-delete do espelho de usuario (item #4 do AUDIT).
//  - deleteUserByClerkId MARCA deletedAt (nao apaga a linha);
//  - getUserRole passa a retornar null (acesso removido);
//  - getUsers nao lista o soft-deleted;
//  - um pedido referenciando aquele clerk_user_id CONTINUA existindo (sem orfao
//    removido — orders/redemptions apontam para o id por TEXTO, sem FK real).
//  - upsertUserFromClerk revive o id (deletedAt volta a null).
// Opt-in via TEST_DATABASE_URL.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("soft-delete do espelho de usuario", () => {
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

  async function seedUser(): Promise<string> {
    const clerkUserId = `u-${randomUUID().slice(0, 12)}`;
    await prisma.user.create({
      data: { clerkUserId, email: `${clerkUserId}@t.com`, name: "T", role: "cliente" },
    });
    return clerkUserId;
  }

  async function seedOrder(userId: string): Promise<number> {
    const order = await prisma.order.create({
      data: {
        userId,
        customerName: "T",
        customerEmail: "t@t.com",
        customerPhone: "0",
        addressCep: "0",
        addressStreet: "r",
        addressCity: "c",
        addressState: "PR",
        subtotalCents: 2000,
        totalCents: 2000,
        paymentMethod: "PIX",
      },
    });
    return order.id;
  }

  it("marca deletedAt em vez de apagar a linha; remove acesso e some da lista", async () => {
    const clerkUserId = await seedUser();
    const orderId = await seedOrder(clerkUserId);

    await users.deleteUserByClerkId(clerkUserId);

    // Linha continua existindo, agora com deletedAt setado.
    const row = await prisma.user.findUnique({ where: { clerkUserId } });
    expect(row).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();

    // Acesso removido.
    const role = await users.getUserRole(clerkUserId);
    expect(role).toBeNull();

    // Fora da listagem do admin.
    const list = await users.getUsers();
    expect(list.find((u: any) => u.clerkUserId === clerkUserId)).toBeUndefined();

    // O pedido NAO ficou orfao removido — continua existindo apontando ao mesmo id.
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    expect(order).not.toBeNull();
    expect(order.userId).toBe(clerkUserId);
  });

  it("nao re-marca quem ja foi soft-deleted (deletedAt preservado)", async () => {
    const clerkUserId = await seedUser();
    await users.deleteUserByClerkId(clerkUserId);
    const first = await prisma.user.findUnique({ where: { clerkUserId } });

    await users.deleteUserByClerkId(clerkUserId);
    const second = await prisma.user.findUnique({ where: { clerkUserId } });

    expect(second.deletedAt.getTime()).toBe(first.deletedAt.getTime());
  });

  it("isUserSoftDeleted: ativo=false, deletado=true, AUSENTE do espelho=false (sync atrasado nao bloqueia)", async () => {
    const clerkUserId = await seedUser();

    // Ativo: nao bloqueia.
    expect(await users.isUserSoftDeleted(clerkUserId)).toBe(false);

    // Soft-deleted: bloqueia (base do guard requireActiveUser das telas do cliente).
    await users.deleteUserByClerkId(clerkUserId);
    expect(await users.isUserSoftDeleted(clerkUserId)).toBe(true);

    // Ausente do espelho (webhook ainda nao sincronizou): NAO bloqueia.
    expect(await users.isUserSoftDeleted("u-nunca-sincronizado")).toBe(false);

    // Revivido pelo upsert: volta a nao bloquear.
    await users.upsertUserFromClerk({
      clerkUserId,
      email: `${clerkUserId}@t.com`,
      name: "T",
      emailIsAdmin: false,
    });
    expect(await users.isUserSoftDeleted(clerkUserId)).toBe(false);
  });

  it("upsertUserFromClerk revive um id que reaparece (deletedAt volta a null)", async () => {
    const clerkUserId = await seedUser();
    await users.deleteUserByClerkId(clerkUserId);
    expect(await users.getUserRole(clerkUserId)).toBeNull();

    await users.upsertUserFromClerk({
      clerkUserId,
      email: `${clerkUserId}@t.com`,
      name: "T",
      emailIsAdmin: false,
    });

    const row = await prisma.user.findUnique({ where: { clerkUserId } });
    expect(row.deletedAt).toBeNull();
    expect(await users.getUserRole(clerkUserId)).toBe("cliente");
  });
});

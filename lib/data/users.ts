import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import type { UserModel } from "../generated/prisma/models";
import { writeAuditLog, type AuditActor } from "./audit";

/**
 * Camada de dados de usuarios — espelho local do Clerk (F9).
 *
 * O webhook do Clerk (app/api/webhooks/clerk) mantem esta tabela em dia. A role
 * (cliente/admin) e a fonte de verdade da autorizacao no server, ja que o auth e
 * Clerk e nao Supabase Auth.
 *
 * Soft-delete (item #4): user.deleted marca deletedAt em vez de apagar a linha;
 * todas as leituras de acesso/admin filtram deletedAt IS NULL.
 */
export type Role = "cliente" | "admin";

/** Cliente do banco: o singleton global OU um TransactionClient (ledger do webhook). */
type DbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Upsert do usuario vindo do Clerk. Nunca rebaixa um admin existente. Aceita um
 * `db` opcional (o `tx` do ledger do webhook) para rodar na MESMA transacao do
 * registro do evento — evita "evento registrado mas efeito nao aplicado".
 *
 * AUTO-HEAL de admin por e-mail: a role e 'admin' se QUALQUER das condicoes valer:
 *   (1) o e-mail esta em ADMIN_EMAILS (bootstrap por allowlist);
 *   (2) esta MESMA linha (mesmo clerk_user_id) ja era admin (nunca rebaixa);
 *   (3) OUTRA linha nao-deletada com o MESMO e-mail ja e admin.
 * O (3) cobre a TROCA de clerk_user_id (conta recriada no Clerk ganha um id novo,
 * gerando uma 2a linha): sem ele, o role=admin ficaria preso no id antigo e o login
 * novo entraria como cliente. Mesmo modelo de confianca do fallback por e-mail
 * (isAdminEmail) — o Clerk verifica a posse do e-mail no cadastro.
 */
export async function upsertUserFromClerk(
  input: {
    clerkUserId: string;
    email: string;
    name: string | null;
    emailIsAdmin: boolean;
  },
  db: DbClient = prisma,
): Promise<void> {
  const existing = await db.user.findUnique({
    where: { clerkUserId: input.clerkUserId },
    select: { role: true },
  });

  // (3): so consulta quando ainda nao e admin pelas vias baratas (1)/(2).
  let siblingIsAdmin = false;
  if (!input.emailIsAdmin && existing?.role !== "admin") {
    const sibling = await db.user.findFirst({
      where: {
        email: { equals: input.email, mode: "insensitive" },
        role: "admin",
        deletedAt: null,
        clerkUserId: { not: input.clerkUserId },
      },
      select: { id: true },
    });
    siblingIsAdmin = sibling !== null;
  }

  const role: Role =
    input.emailIsAdmin || existing?.role === "admin" || siblingIsAdmin ? "admin" : "cliente";

  // deletedAt: null em create e update revive um id que reaparece no Clerk (um
  // usuario re-criado com o mesmo clerk_user_id volta a ter acesso).
  await db.user.upsert({
    where: { clerkUserId: input.clerkUserId },
    create: {
      clerkUserId: input.clerkUserId,
      email: input.email,
      name: input.name,
      role,
      deletedAt: null,
    },
    update: { email: input.email, name: input.name, role, deletedAt: null },
  });
}

/**
 * Soft-delete do espelho (evento user.deleted) — item #4. Marca deletedAt em vez
 * de apagar, preservando o historico (orders/redemptions apontam para o
 * clerk_user_id por TEXTO, sem FK real, e nao podem ficar sem o registro espelho).
 * updateMany-style: nao lanca se nao existir e nao re-marca quem ja foi deletado.
 * Aceita o `tx` opcional do ledger do webhook (roda na MESMA transacao do evento).
 */
export async function deleteUserByClerkId(
  clerkUserId: string,
  db: DbClient = prisma,
): Promise<void> {
  await db.user.updateMany({
    where: { clerkUserId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
}

/**
 * true se o espelho marca o usuario como SOFT-DELETED (deletedAt preenchido).
 * Distincao importante vs getUserRole: AUSENTE do espelho => false (usuario
 * recem-criado cujo webhook ainda nao sincronizou NAO pode ser bloqueado) —
 * so o deletedAt explicito bloqueia. Consumido por lib/auth/requireActiveUser
 * (telas/actions do cliente): a sessao Clerk pode sobreviver alguns instantes
 * ao user.deleted, e o espelho pode ser desativado direto no banco.
 */
export async function isUserSoftDeleted(clerkUserId: string): Promise<boolean> {
  const row = await prisma.user.findFirst({
    where: { clerkUserId, NOT: { deletedAt: null } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Role do usuario; null se ainda nao sincronizado OU soft-deleted (um usuario
 * removido no Clerk nao deve manter acesso).
 */
export async function getUserRole(clerkUserId: string): Promise<Role | null> {
  const user = await prisma.user.findFirst({
    where: { clerkUserId, deletedAt: null },
    select: { role: true },
  });
  return user ? (user.role as Role) : null;
}

// ============================================================================
// ADMIN — leitura e alteracao auditada de role.
// ============================================================================

/** Tipo de dominio do usuario para o admin (camelCase; datas em ISO 8601). */
export type AdminUser = {
  id: string;
  clerkUserId: string;
  email: string;
  name: string | null;
  role: Role;
  /** ISO 8601. */
  createdAt: string;
};

function toAdminUser(row: UserModel): AdminUser {
  return {
    id: row.id,
    clerkUserId: row.clerkUserId,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Usuarios para o admin (mais recentes primeiro), EXCLUINDO os soft-deleted. */
export async function getUsers(): Promise<AdminUser[]> {
  const rows = await prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toAdminUser);
}

export type SetUserRoleResult = { ok: true; user: AdminUser } | { ok: false; error: string };

/**
 * Altera a role de um usuario (acao de admin EXPLICITA e AUDITADA — item #3).
 * Grava audit_log (user.role_update; before/after com a role) na MESMA transacao
 * (invariante 3). Espelha o result discriminado de CouponMutationResult.
 *
 * Guarda anti-lockout: o admin NAO pode alterar a PROPRIA role (auto-rebaixamento
 * deixaria o sistema sem admin se for o ultimo / trancaria o proprio acesso).
 *
 * NUANCE (re-promocao no sync): o proximo sync do Clerk (upsertUserFromClerk) RE-PROMOVE
 * o alvo a admin se o e-mail estiver em ADMIN_EMAILS OU se OUTRA linha nao-deletada com
 * o mesmo e-mail ainda for admin (auto-heal por e-mail). Para rebaixar em definitivo:
 * remova o e-mail de ADMIN_EMAILS E rebaixe TODAS as linhas daquele e-mail. Isso e
 * esperado — por isso NAO mexemos no sync.
 */
export async function setUserRole(
  actor: AuditActor,
  clerkUserId: string,
  role: Role,
): Promise<SetUserRoleResult> {
  if (actor.clerkUserId !== null && actor.clerkUserId === clerkUserId) {
    return { ok: false, error: "Você não pode alterar a própria role." };
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findFirst({ where: { clerkUserId, deletedAt: null } });
    if (!existing) return null;
    const before = toAdminUser(existing);
    const row = await tx.user.update({ where: { clerkUserId }, data: { role } });
    const after = toAdminUser(row);
    await writeAuditLog(tx, {
      actor,
      action: AuditAction.user_role_update,
      entityType: AuditEntityType.user,
      entityId: clerkUserId,
      before: { role: before.role },
      after: { role: after.role },
    });
    return after;
  });

  if (!result) return { ok: false, error: "Usuário não encontrado." };
  return { ok: true, user: result };
}

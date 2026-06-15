import { currentUser } from "@clerk/nextjs/server";

import { isClerkConfigured } from "@/lib/services/clerk/config";
import { isAdminEmail } from "@/lib/services/clerk/roles";

import { Prisma } from "../generated/prisma/client";
import type { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import { getUserRole, type Role } from "./users";

/**
 * Trilha de auditoria (FUNDACAO) — dono unico de writeAuditLog/getAuditActor.
 *
 * Invariante 3: TODA mutacao de admin grava uma linha em audit_log na MESMA
 * transacao da mutacao. Por isso writeAuditLog recebe o `tx` (Prisma.TransactionClient)
 * da operacao — nunca o `prisma` global, senao a atomicidade se perde.
 */

/**
 * Contexto do ator resolvido no server ANTES de abrir a transacao (invariante 4).
 * Em modo mock-first (sem Clerk) os tres campos sao null e a auditoria ainda grava
 * (ator anonimo de dev).
 */
export type AuditActor = {
  clerkUserId: string | null;
  email: string | null;
  role: Role | null;
};

/**
 * Resolve o ator atual (Clerk). Mock-first: sem Clerk, devolve ator anonimo.
 * Espelha a logica do guard em app/admin/layout.tsx.
 */
export async function getAuditActor(): Promise<AuditActor> {
  if (!isClerkConfigured()) {
    return { clerkUserId: null, email: null, role: null };
  }
  const user = await currentUser();
  if (!user) {
    return { clerkUserId: null, email: null, role: null };
  }
  const email =
    user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  const role = (await getUserRole(user.id)) ?? (isAdminEmail(email) ? "admin" : "cliente");
  return { clerkUserId: user.id, email, role };
}

/** Snapshot jsonb absente -> NULL no banco (coluna nullable). */
function toJson(value: Prisma.InputJsonValue | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value ?? Prisma.DbNull;
}

export type AuditEntry = {
  actor: AuditActor;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  requestId?: string | null;
  ip?: string | null;
};

/**
 * Insere uma linha em audit_log DENTRO da transacao recebida (invariante 3).
 * `action`/`entityType` sao os enums Prisma gerados (ex.: 'product.update').
 * before/after sao snapshots do dominio (camelCase, *Cents inteiros) ou null.
 */
export async function writeAuditLog(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorClerkUserId: entry.actor.clerkUserId,
      actorEmail: entry.actor.email,
      actorRole: entry.actor.role,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: toJson(entry.before),
      after: toJson(entry.after),
      requestId: entry.requestId ?? null,
      ip: entry.ip ?? null,
    },
  });
}

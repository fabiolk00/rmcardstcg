import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import type { CouponType } from "../generated/prisma/enums";
import type { CouponModel } from "../generated/prisma/models";
import { writeAuditLog, type AuditActor } from "./audit";

/**
 * Camada de dados de cupom — Postgres via Prisma (lib/db).
 *
 * Fronteira DB <-> dominio (snake_case -> camelCase; dinheiro Int de centavos;
 * valueCents/percentOff conforme o tipo). O codigo e normalizado em UPPER no
 * dominio; a unicidade real e case-insensitive via indice LOWER(code) (FUNDACAO).
 *
 * Mutacoes de admin (create/update/deactivate) gravam audit_log na MESMA
 * transacao (invariante 3). A aplicacao no checkout (redeemCoupon) e atomica e
 * idempotente por pedido (invariantes 1 e 2).
 */

/** Tipo de dominio do cupom (camelCase, *Cents inteiros). */
export type Coupon = {
  id: string;
  code: string;
  type: CouponType;
  /** 1..100 quando type='percent'; null caso contrario. */
  percentOff: number | null;
  /** centavos > 0 quando type='fixed'; null caso contrario. */
  valueCents: number | null;
  /** Piso de mercadoria (merchandiseCents) para o cupom valer. */
  minSubtotalCents: number;
  /** null = ilimitado. */
  maxRedemptions: number | null;
  /** null = sem limite por usuario. */
  perUserLimit: number | null;
  redeemedCount: number;
  isActive: boolean;
  /** ISO 8601 ou null. */
  startsAt: string | null;
  /** ISO 8601 ou null. */
  expiresAt: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
};

function toCoupon(row: CouponModel): Coupon {
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    percentOff: row.percentOff,
    valueCents: row.valueCents,
    minSubtotalCents: row.minSubtotalCents,
    maxRedemptions: row.maxRedemptions,
    perUserLimit: row.perUserLimit,
    redeemedCount: row.redeemedCount,
    isActive: row.isActive,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Snapshot do dominio para o audit_log (before/after). */
function couponSnapshot(c: Coupon): Prisma.InputJsonValue {
  return {
    code: c.code,
    type: c.type,
    percentOff: c.percentOff,
    valueCents: c.valueCents,
    minSubtotalCents: c.minSubtotalCents,
    maxRedemptions: c.maxRedemptions,
    perUserLimit: c.perUserLimit,
    isActive: c.isActive,
    startsAt: c.startsAt,
    expiresAt: c.expiresAt,
  };
}

/** Normaliza o codigo para a forma canonica do dominio (sem espacos, UPPER). */
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

// ============================================================================
// LEITURA (admin)
// ============================================================================

/** Todos os cupons (admin), mais recentes primeiro. */
export async function getCoupons(): Promise<Coupon[]> {
  const rows = await prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(toCoupon);
}

/** Cupom por id; null se nao existir. */
export async function getCouponById(id: string): Promise<Coupon | null> {
  const row = await prisma.coupon.findUnique({ where: { id } });
  return row ? toCoupon(row) : null;
}

/** Cupom por codigo (case-insensitive); null se nao existir. */
export async function getCouponByCode(code: string): Promise<Coupon | null> {
  const normalized = normalizeCouponCode(code);
  const row = await prisma.coupon.findFirst({
    where: { code: { equals: normalized, mode: "insensitive" } },
  });
  return row ? toCoupon(row) : null;
}

// ============================================================================
// CRUD (admin) — toda mutacao grava audit_log na MESMA transacao.
// ============================================================================

/** Dados de entrada para criar/editar um cupom (ja validados no server action). */
export type CouponInput = {
  code: string;
  type: CouponType;
  percentOff: number | null;
  valueCents: number | null;
  minSubtotalCents: number;
  maxRedemptions: number | null;
  perUserLimit: number | null;
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
};

export type CouponMutationResult = { ok: true; coupon: Coupon } | { ok: false; error: string };

/** Normaliza CouponInput em colunas, garantindo a coerencia tipo<->campo. */
function toCouponData(input: CouponInput) {
  const isPercent = input.type === "percent";
  return {
    code: normalizeCouponCode(input.code),
    type: input.type,
    percentOff: isPercent ? input.percentOff : null,
    valueCents: isPercent ? null : input.valueCents,
    minSubtotalCents: input.minSubtotalCents,
    maxRedemptions: input.maxRedemptions,
    perUserLimit: input.perUserLimit,
    isActive: input.isActive,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  };
}

/** Cria um cupom. Grava audit_log na mesma transacao. Codigo duplicado => erro tratado. */
export async function createCoupon(
  actor: AuditActor,
  input: CouponInput,
): Promise<CouponMutationResult> {
  const data = toCouponData(input);
  try {
    const coupon = await prisma.$transaction(async (tx) => {
      const row = await tx.coupon.create({ data });
      const created = toCoupon(row);
      await writeAuditLog(tx, {
        actor,
        action: AuditAction.coupon_create,
        entityType: AuditEntityType.coupon,
        entityId: created.id,
        before: null,
        after: couponSnapshot(created),
      });
      return created;
    });
    return { ok: true, coupon };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "Já existe um cupom com esse código." };
    }
    throw err;
  }
}

/** Edita um cupom existente. redeemedCount NUNCA e tocado por aqui (so pela redencao). */
export async function updateCoupon(
  actor: AuditActor,
  id: string,
  input: CouponInput,
): Promise<CouponMutationResult> {
  const data = toCouponData(input);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.coupon.findUnique({ where: { id } });
      if (!existing) return null;
      const before = toCoupon(existing);
      const row = await tx.coupon.update({ where: { id }, data });
      const after = toCoupon(row);
      await writeAuditLog(tx, {
        actor,
        action: AuditAction.coupon_update,
        entityType: AuditEntityType.coupon,
        entityId: id,
        before: couponSnapshot(before),
        after: couponSnapshot(after),
      });
      return after;
    });
    if (!result) return { ok: false, error: "Cupom não encontrado." };
    return { ok: true, coupon: result };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "Já existe um cupom com esse código." };
    }
    throw err;
  }
}

/** Ativa/inativa um cupom. coupon_deactivate ao desligar; coupon_update ao religar. */
export async function setCouponActive(
  actor: AuditActor,
  id: string,
  isActive: boolean,
): Promise<CouponMutationResult> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.coupon.findUnique({ where: { id } });
    if (!existing) return null;
    const before = toCoupon(existing);
    const row = await tx.coupon.update({ where: { id }, data: { isActive } });
    const after = toCoupon(row);
    await writeAuditLog(tx, {
      actor,
      action: isActive ? AuditAction.coupon_update : AuditAction.coupon_deactivate,
      entityType: AuditEntityType.coupon,
      entityId: id,
      before: couponSnapshot(before),
      after: couponSnapshot(after),
    });
    return after;
  });
  if (!result) return { ok: false, error: "Cupom não encontrado." };
  return { ok: true, coupon: result };
}

export type CouponDeleteResult = { ok: true; id: string } | { ok: false; error: string };

/** Mensagem unica para "tem redencao": NUNCA exclui cupom com historico financeiro. */
const COUPON_IN_USE =
  "Cupom já foi utilizado e não pode ser excluído. Inative-o para tirá-lo de circulação." as const;

/**
 * Exclui um cupom PERMANENTEMENTE (o "D" do CRUD). Diferente de setCouponActive
 * (inativacao reversivel), o registro deixa de existir.
 *
 * Guarda de integridade: so exclui se o cupom NUNCA foi redimido. coupon_redemptions
 * guarda dados financeiros (discountCents) atrelados a pedidos reais e a FK e
 * onDelete: Restrict — apagar um cupom usado destruiria historico fiscal/auditoria
 * (ver AUDIT.md). Cupom ja usado deve ser INATIVADO, nao excluido.
 *
 * Grava audit_log (coupon_delete, before=snapshot, after=null) na MESMA transacao
 * (invariante 3). A contagem de redencoes e o delete correm na mesma transacao; uma
 * redencao inserida nesse meio dispara a FK Restrict (P2003), tratada como "em uso".
 */
export async function deleteCoupon(actor: AuditActor, id: string): Promise<CouponDeleteResult> {
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const existing = await tx.coupon.findUnique({ where: { id } });
      if (!existing) return "not_found" as const;

      const redemptions = await tx.couponRedemption.count({ where: { couponId: id } });
      if (redemptions > 0) return "in_use" as const;

      const before = toCoupon(existing);
      await tx.coupon.delete({ where: { id } });
      await writeAuditLog(tx, {
        actor,
        action: AuditAction.coupon_delete,
        entityType: AuditEntityType.coupon,
        entityId: id,
        before: couponSnapshot(before),
        after: null,
      });
      return "ok" as const;
    });

    if (outcome === "not_found") return { ok: false, error: "Cupom não encontrado." };
    if (outcome === "in_use") return { ok: false, error: COUPON_IN_USE };
    return { ok: true, id };
  } catch (err) {
    // Corrida: redencao gravada entre a contagem e o delete -> FK Restrict.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return { ok: false, error: COUPON_IN_USE };
    }
    throw err;
  }
}

// ============================================================================
// VALIDACAO + REDENCAO (checkout) — 100% server-side, atomica e idempotente.
// ============================================================================

/** Por que um cupom nao pode ser aplicado (mensagens amigaveis no checkout). */
export type CouponRejection =
  | "not_found"
  | "inactive"
  | "not_started"
  | "expired"
  | "below_min"
  | "max_redemptions"
  | "per_user_limit";

export type CouponValidation =
  | { ok: true; coupon: Coupon }
  | { ok: false; reason: CouponRejection };

/**
 * Valida um cupom para um carrinho (server-only): existe, ativo, dentro da janela,
 * merchandiseCents >= minSubtotalCents, e dentro dos limites global e por usuario.
 * Pre-check (UI/feedback); a garantia anti-corrida e refeita em redeemCoupon.
 */
export async function validateCoupon(input: {
  code: string;
  merchandiseCents: number;
  userId: string;
  now?: Date;
}): Promise<CouponValidation> {
  const coupon = await getCouponByCode(input.code);
  if (!coupon) return { ok: false, reason: "not_found" };
  if (!coupon.isActive) return { ok: false, reason: "inactive" };

  const now = input.now ?? new Date();
  if (coupon.startsAt && new Date(coupon.startsAt) > now) {
    return { ok: false, reason: "not_started" };
  }
  if (coupon.expiresAt && new Date(coupon.expiresAt) <= now) {
    return { ok: false, reason: "expired" };
  }
  if (input.merchandiseCents < coupon.minSubtotalCents) {
    return { ok: false, reason: "below_min" };
  }
  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { ok: false, reason: "max_redemptions" };
  }
  if (coupon.perUserLimit !== null) {
    const used = await prisma.couponRedemption.count({
      where: { couponId: coupon.id, userId: input.userId },
    });
    if (used >= coupon.perUserLimit) {
      return { ok: false, reason: "per_user_limit" };
    }
  }
  return { ok: true, coupon };
}

export type RedeemResult =
  | { ok: true; alreadyRedeemed: boolean }
  | { ok: false; reason: CouponRejection };

/**
 * Redime o cupom para um pedido DENTRO da transacao do checkout (recebe o `tx`).
 *
 * Idempotencia (invariante 2): coupon_redemptions.order_id e UNIQUE — redencao
 * repetida do mesmo pedido = no-op (alreadyRedeemed: true).
 *
 * Anti-corrida do limite global (invariante 1): increment ATOMICO via updateMany
 * WHERE id=couponId AND (max_redemptions IS NULL OR redeemed_count < max). count==0
 * => esgotado: aborta (o chamador deve dar rollback).
 *
 * Limite por usuario: recontado dentro da transacao antes de inserir.
 */
export async function redeemCoupon(
  tx: Prisma.TransactionClient,
  input: {
    couponId: string;
    orderId: number;
    userId: string;
    discountCents: number;
    perUserLimit: number | null;
    maxRedemptions: number | null;
  },
): Promise<RedeemResult> {
  const existing = await tx.couponRedemption.findUnique({ where: { orderId: input.orderId } });
  if (existing) return { ok: true, alreadyRedeemed: true };

  if (input.perUserLimit !== null) {
    // Serializa redencoes do MESMO (cupom,usuario) sem depender de SSI: um segundo
    // checkout concorrente bloqueia neste advisory lock ate o primeiro commitar e,
    // ao desbloquear, reconta ja com a redencao gravada. Liberado no fim da tx.
    const lockKey = `coupon:${input.couponId}:${input.userId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const used = await tx.couponRedemption.count({
      where: { couponId: input.couponId, userId: input.userId },
    });
    if (used >= input.perUserLimit) {
      return { ok: false, reason: "per_user_limit" };
    }
  }

  const inc = await tx.coupon.updateMany({
    where:
      input.maxRedemptions === null
        ? { id: input.couponId }
        : { id: input.couponId, redeemedCount: { lt: input.maxRedemptions } },
    data: { redeemedCount: { increment: 1 } },
  });
  if (inc.count === 0) {
    return { ok: false, reason: "max_redemptions" };
  }

  await tx.couponRedemption.create({
    data: {
      couponId: input.couponId,
      orderId: input.orderId,
      userId: input.userId,
      discountCents: input.discountCents,
    },
  });

  return { ok: true, alreadyRedeemed: false };
}

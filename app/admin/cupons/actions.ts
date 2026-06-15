"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/requireAdmin";
import {
  createCoupon,
  deleteCoupon,
  setCouponActive,
  updateCoupon,
  type CouponDeleteResult,
  type CouponInput,
  type CouponMutationResult,
} from "@/lib/data/coupons";

/**
 * Server actions de cupom (admin). Toda action:
 * 1) re-verifica a role no server via requireAdmin (invariante 4);
 * 2) valida o payload no server (nunca confiar no client);
 * 3) delega para a data layer, que grava audit_log na MESMA transacao;
 * 4) revalidatePath("/admin/cupons").
 *
 * NOTA: nao exportar runtime/dynamic daqui (arquivo "use server" so exporta
 * funcoes async). A page (app/admin/cupons/page.tsx) ja garante dynamic.
 */

/** Payload do formulario (strings da UI -> tipos validados). */
export type CouponFormPayload = {
  code: string;
  type: "percent" | "fixed";
  percentOff?: number | null;
  valueCents?: number | null;
  minSubtotalCents?: number;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
  isActive?: boolean;
  startsAt?: string | null;
  expiresAt?: string | null;
};

function fail(error: string): CouponMutationResult {
  return { ok: false, error };
}

/** Valida e normaliza o payload em CouponInput. Erro => string amigavel. */
function parsePayload(p: CouponFormPayload): CouponInput | { error: string } {
  const code = (p.code ?? "").trim();
  if (!code) return { error: "Informe o código do cupom." };
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) {
    return { error: "Código deve ter 3–32 caracteres (letras, números, - ou _)." };
  }

  if (p.type !== "percent" && p.type !== "fixed") {
    return { error: "Tipo de cupom inválido." };
  }

  let percentOff: number | null = null;
  let valueCents: number | null = null;
  if (p.type === "percent") {
    const pct = Number(p.percentOff);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
      return { error: "Percentual deve ser um inteiro entre 1 e 100." };
    }
    percentOff = pct;
  } else {
    const cents = Number(p.valueCents);
    if (!Number.isInteger(cents) || cents <= 0) {
      return { error: "Valor fixo deve ser maior que zero." };
    }
    valueCents = cents;
  }

  const minSubtotalCents = Number(p.minSubtotalCents ?? 0);
  if (!Number.isInteger(minSubtotalCents) || minSubtotalCents < 0) {
    return { error: "Valor mínimo do pedido inválido." };
  }

  const maxRedemptions =
    p.maxRedemptions === null || p.maxRedemptions === undefined ? null : Number(p.maxRedemptions);
  if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 0)) {
    return { error: "Limite total de usos inválido." };
  }

  const perUserLimit =
    p.perUserLimit === null || p.perUserLimit === undefined ? null : Number(p.perUserLimit);
  if (perUserLimit !== null && (!Number.isInteger(perUserLimit) || perUserLimit < 1)) {
    return { error: "Limite por usuário inválido." };
  }

  const startsAt = p.startsAt ? p.startsAt : null;
  const expiresAt = p.expiresAt ? p.expiresAt : null;
  if (startsAt && expiresAt && new Date(expiresAt) <= new Date(startsAt)) {
    return { error: "A data de expiração deve ser posterior ao início." };
  }

  return {
    code,
    type: p.type,
    percentOff,
    valueCents,
    minSubtotalCents,
    maxRedemptions,
    perUserLimit,
    isActive: p.isActive ?? true,
    startsAt,
    expiresAt,
  };
}

export async function createCouponAction(
  payload: CouponFormPayload,
): Promise<CouponMutationResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return fail(guard.error);

  const parsed = parsePayload(payload);
  if ("error" in parsed) return fail(parsed.error);

  const result = await createCoupon(guard.actor, parsed);
  if (result.ok) revalidatePath("/admin/cupons");
  return result;
}

export async function updateCouponAction(
  id: string,
  payload: CouponFormPayload,
): Promise<CouponMutationResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return fail(guard.error);
  if (!id) return fail("Cupom inválido.");

  const parsed = parsePayload(payload);
  if ("error" in parsed) return fail(parsed.error);

  const result = await updateCoupon(guard.actor, id, parsed);
  if (result.ok) revalidatePath("/admin/cupons");
  return result;
}

export async function setCouponActiveAction(
  id: string,
  isActive: boolean,
): Promise<CouponMutationResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return fail(guard.error);
  if (!id) return fail("Cupom inválido.");

  const result = await setCouponActive(guard.actor, id, isActive);
  if (result.ok) revalidatePath("/admin/cupons");
  return result;
}

/** Exclusao permanente (o "D" do CRUD). Bloqueada para cupom ja redimido. */
export async function deleteCouponAction(id: string): Promise<CouponDeleteResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!id) return { ok: false, error: "Cupom inválido." };

  const result = await deleteCoupon(guard.actor, id);
  if (result.ok) revalidatePath("/admin/cupons");
  return result;
}

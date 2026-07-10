import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import type { CategoryModel } from "../generated/prisma/models";
import { writeAuditLog, type AuditActor } from "./audit";

/**
 * Camada de dados de categoria — Postgres via Prisma (lib/db).
 *
 * Catalogo informativo (nome/descricao) DESACOPLADO de Product.category (que
 * continua String validada contra CATEGORIES em lib/data/types.ts — nao ha FK
 * nem qualquer leitura cruzada aqui). Espelha lib/data/coupons.ts: mutacoes de
 * admin gravam audit_log na MESMA transacao (invariante 3).
 */

/** Tipo de dominio da categoria (camelCase). */
export type Category = {
  id: string;
  name: string;
  description: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
};

function toCategory(row: CategoryModel): Category {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Snapshot do dominio para o audit_log (before/after). */
function categorySnapshot(c: Category): Prisma.InputJsonValue {
  return {
    name: c.name,
    description: c.description,
  };
}

// ============================================================================
// LEITURA (admin)
// ============================================================================

/** Todas as categorias (admin), ordem alfabetica (catalogo, nao por data). */
export async function getCategories(): Promise<Category[]> {
  const rows = await prisma.category.findMany({ orderBy: { name: "asc" } });
  return rows.map(toCategory);
}

/** Categoria por id; null se nao existir. */
export async function getCategoryById(id: string): Promise<Category | null> {
  const row = await prisma.category.findUnique({ where: { id } });
  return row ? toCategory(row) : null;
}

// ============================================================================
// CRUD (admin) — toda mutacao grava audit_log na MESMA transacao.
// ============================================================================

/** Erro de validacao de dominio — vira mensagem amigavel na server action. */
export class CategoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CategoryValidationError";
  }
}

/** Dados de entrada para criar/editar uma categoria (nao normalizados). */
export type CategoryInput = {
  name: string;
  description: string | null;
};

type NormalizedCategoryInput = {
  name: string;
  description: string | null;
};

const NAME_MIN = 2;
const NAME_MAX = 100;
const DESC_MAX = 500;

/**
 * Valida e normaliza um CategoryInput: nome obrigatorio (trim, 2..100 chars),
 * descricao opcional (trim, ate 500 chars; vazio vira null). Lanca
 * CategoryValidationError (pt-BR) em caso de violacao. Funcao pura (sem I/O),
 * testavel sem banco.
 */
export function normalizeCategoryInput(input: CategoryInput): NormalizedCategoryInput {
  const name = input.name?.trim() ?? "";
  if (name === "") throw new CategoryValidationError("O nome da categoria é obrigatório.");
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    throw new CategoryValidationError(`O nome deve ter entre ${NAME_MIN} e ${NAME_MAX} caracteres.`);
  }

  const description = input.description?.trim() ? input.description.trim() : null;
  if (description && description.length > DESC_MAX) {
    throw new CategoryValidationError(`A descrição excede ${DESC_MAX} caracteres.`);
  }

  return { name, description };
}

export type CategoryMutationResult =
  | { ok: true; category: Category }
  | { ok: false; error: string };

/** Mensagem unica para nome duplicado (case-insensitive). */
function duplicateNameError(name: string): string {
  return `Já existe uma categoria com o nome "${name}".`;
}

/**
 * Cria uma categoria. Checa duplicidade case-insensitive por nome ANTES do
 * create (mesmo padrao do SKU em products.ts) e grava audit_log na MESMA
 * transacao. Nome duplicado => erro tratado (nunca lanca).
 */
export async function createCategory(
  actor: AuditActor,
  input: CategoryInput,
): Promise<CategoryMutationResult> {
  const data = normalizeCategoryInput(input);

  const category = await prisma.$transaction(async (tx) => {
    const clash = await tx.category.findFirst({
      where: { name: { equals: data.name, mode: "insensitive" } },
      select: { id: true },
    });
    if (clash) return null;

    const row = await tx.category.create({ data });
    const created = toCategory(row);
    await writeAuditLog(tx, {
      actor,
      action: AuditAction.category_create,
      entityType: AuditEntityType.category,
      entityId: created.id,
      before: null,
      after: categorySnapshot(created),
    });
    return created;
  });

  if (!category) return { ok: false, error: duplicateNameError(data.name) };
  return { ok: true, category };
}

/**
 * Edita uma categoria existente. Mesma checagem de duplicidade (excluindo o
 * proprio id) e audit_log (before/after) na MESMA transacao.
 */
export async function updateCategory(
  actor: AuditActor,
  id: string,
  input: CategoryInput,
): Promise<CategoryMutationResult> {
  const data = normalizeCategoryInput(input);

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.category.findUnique({ where: { id } });
    if (!existing) return "not_found" as const;

    const clash = await tx.category.findFirst({
      where: { name: { equals: data.name, mode: "insensitive" }, id: { not: id } },
      select: { id: true },
    });
    if (clash) return "duplicate" as const;

    const before = toCategory(existing);
    const row = await tx.category.update({ where: { id }, data });
    const after = toCategory(row);
    await writeAuditLog(tx, {
      actor,
      action: AuditAction.category_update,
      entityType: AuditEntityType.category,
      entityId: id,
      before: categorySnapshot(before),
      after: categorySnapshot(after),
    });
    return after;
  });

  if (result === "not_found") return { ok: false, error: "Categoria não encontrada." };
  if (result === "duplicate") return { ok: false, error: duplicateNameError(data.name) };
  return { ok: true, category: result };
}

export type CategoryDeleteResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Exclui uma categoria PERMANENTEMENTE. Catalogo desacoplado (sem FK apontando
 * para categories) — hard delete simples, sem guarda de "em uso". Grava
 * audit_log (category_delete, before=snapshot, after=null) na MESMA transacao.
 */
export async function deleteCategory(actor: AuditActor, id: string): Promise<CategoryDeleteResult> {
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.category.findUnique({ where: { id } });
    if (!existing) return "not_found" as const;

    const before = toCategory(existing);
    await tx.category.delete({ where: { id } });
    await writeAuditLog(tx, {
      actor,
      action: AuditAction.category_delete,
      entityType: AuditEntityType.category,
      entityId: id,
      before: categorySnapshot(before),
      after: null,
    });
    return "ok" as const;
  });

  if (outcome === "not_found") return { ok: false, error: "Categoria não encontrada." };
  return { ok: true, id };
}

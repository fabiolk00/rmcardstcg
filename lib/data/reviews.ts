import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import type { ReviewModel } from "../generated/prisma/models";
import { writeAuditLog, type AuditActor } from "./audit";
import { summarizeFromCounts } from "./review-stats";
import type { Review, ReviewStats, ReviewStatus } from "./types";

/**
 * Camada de dados de avaliacoes — Postgres via Prisma.
 *
 * Moderacao: a review nasce 'pending'; so 'approved' aparece na vitrine e conta no
 * agregado. Product.rating/reviewCount sao DENORMALIZADOS e recalculados a partir
 * das reviews aprovadas (recalcProductRating) na MESMA transacao do approve/reject,
 * serializados por um lock na linha do produto (espelha updateProduct).
 *
 * Validacao em camadas (schema > service > component): aqui e a camada de SERVICO —
 * o servidor revalida tudo (rating 1..5, tamanhos), nunca confia no client. O CHECK
 * do banco (rating BETWEEN 1 AND 5) e a rede final; a UI valida para feedback.
 */

const BODY_MIN = 10;
const BODY_MAX = 2000;
const NAME_MIN = 2;
const NAME_MAX = 80;
const TITLE_MAX = 120;
export const REVIEWS_PAGE_SIZE = 5;

/** Erro de validacao de dominio — vira mensagem amigavel na server action. */
export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

function toReview(row: ReviewModel): Review {
  return {
    id: row.id,
    productId: row.productId,
    userId: row.userId,
    authorName: row.authorName,
    rating: row.rating,
    title: row.title,
    body: row.body,
    status: row.status as ReviewStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Campos de uma submissao de avaliacao (productId resolvido no server). */
export type ReviewInput = {
  productId: string;
  userId: string;
  authorName: string;
  rating: number;
  title: string | null;
  body: string;
};

type NormalizedReviewInput = {
  productId: string;
  userId: string;
  authorName: string;
  rating: number;
  title: string | null;
  body: string;
};

/** Valida e normaliza a submissao. Lanca ReviewValidationError (pt-BR) em violacao. */
function normalizeReviewInput(input: ReviewInput): NormalizedReviewInput {
  const authorName = input.authorName?.trim() ?? "";
  if (authorName.length < NAME_MIN || authorName.length > NAME_MAX) {
    throw new ReviewValidationError(`O nome deve ter entre ${NAME_MIN} e ${NAME_MAX} caracteres.`);
  }

  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new ReviewValidationError("Escolha uma nota de 1 a 5 estrelas.");
  }

  const body = input.body?.trim() ?? "";
  if (body.length < BODY_MIN) {
    throw new ReviewValidationError(`A avaliação deve ter ao menos ${BODY_MIN} caracteres.`);
  }
  if (body.length > BODY_MAX) {
    throw new ReviewValidationError(`A avaliação excede ${BODY_MAX} caracteres.`);
  }

  const rawTitle = input.title?.trim() ?? "";
  if (rawTitle.length > TITLE_MAX) {
    throw new ReviewValidationError(`O título excede ${TITLE_MAX} caracteres.`);
  }
  const title = rawTitle.length > 0 ? rawTitle : null;

  return {
    productId: input.productId,
    userId: input.userId,
    authorName,
    rating: input.rating,
    title,
    body,
  };
}

/** P2002 (unique) — resubmit do MESMO usuario no MESMO produto colide aqui. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}

export type SubmitReviewResult =
  | { ok: true; review: Review }
  | { ok: false; reason: "validation" | "already_reviewed" | "product_not_found"; error: string };

/**
 * Registra uma avaliacao (status 'pending') para moderacao. Valida no server,
 * confirma que o produto existe e esta ativo, e barra segunda review do mesmo
 * usuario no mesmo produto (UNIQUE -> P2002). productId vem RESOLVIDO pela action
 * (a partir do slug), nunca do client cru.
 */
export async function submitReview(input: ReviewInput): Promise<SubmitReviewResult> {
  let data: NormalizedReviewInput;
  try {
    data = normalizeReviewInput(input);
  } catch (err) {
    if (err instanceof ReviewValidationError) {
      return { ok: false, reason: "validation", error: err.message };
    }
    throw err;
  }

  const product = await prisma.product.findUnique({
    where: { id: data.productId },
    select: { id: true, isActive: true },
  });
  if (!product || !product.isActive) {
    return { ok: false, reason: "product_not_found", error: "Produto não encontrado." };
  }

  try {
    const row = await prisma.review.create({
      data: {
        productId: data.productId,
        userId: data.userId,
        authorName: data.authorName,
        rating: data.rating,
        title: data.title,
        body: data.body,
        status: "pending",
      },
    });
    return { ok: true, review: toReview(row) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "already_reviewed", error: "Você já avaliou este produto." };
    }
    throw err;
  }
}

/**
 * Avaliacoes APROVADAS de um produto, paginadas (mais recentes primeiro). Retorna
 * so a pagina de reviews — o TOTAL para "mostrando N de M" sai do getReviewStats
 * (groupBy), evitando um count() redundante sobre o mesmo predicado por pageview.
 * O indice (product_id, status, created_at DESC) entrega as linhas ja ordenadas.
 */
export async function getApprovedReviews(
  productId: string,
  page = 1,
  pageSize = REVIEWS_PAGE_SIZE,
): Promise<Review[]> {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const skip = (safePage - 1) * pageSize;
  const rows = await prisma.review.findMany({
    where: { productId, status: "approved" },
    orderBy: { createdAt: "desc" },
    skip,
    take: pageSize,
  });
  return rows.map(toReview);
}

/** Distribuicao/media das avaliacoes APROVADAS (UMA query groupBy; sem N+1). */
export async function getReviewStats(productId: string): Promise<ReviewStats> {
  const groups = await prisma.review.groupBy({
    by: ["rating"],
    where: { productId, status: "approved" },
    _count: { _all: true },
  });
  return summarizeFromCounts(groups.map((g) => ({ rating: g.rating, count: g._count._all })));
}

/** Avaliacao + nome/slug do produto (fila de moderacao do admin). Sem N+1 (include). */
export type PendingReview = Review & { productName: string; productSlug: string };

export async function getPendingReviews(): Promise<PendingReview[]> {
  const rows = await prisma.review.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    include: { product: { select: { name: true, slug: true } } },
  });
  return rows.map((r) => ({
    ...toReview(r),
    productName: r.product.name,
    productSlug: r.product.slug,
  }));
}

/**
 * Recalcula o agregado denormalizado do produto (rating + reviewCount) a partir das
 * reviews APROVADAS. Chamado DENTRO da transacao de moderacao, DEPOIS do lock na
 * linha do produto — assim duas moderacoes do mesmo produto serializam e a segunda
 * re-le o agregado ja com o commit da primeira (sem lost update na contagem).
 */
async function recalcProductRating(tx: Prisma.TransactionClient, productId: string): Promise<void> {
  const groups = await tx.review.groupBy({
    by: ["rating"],
    where: { productId, status: "approved" },
    _count: { _all: true },
  });
  const { count, average } = summarizeFromCounts(
    groups.map((g) => ({ rating: g.rating, count: g._count._all })),
  );
  await tx.product.update({
    where: { id: productId },
    data: { rating: new Prisma.Decimal(average.toFixed(1)), reviewCount: count },
  });
}

export type ReviewModerationResult =
  | { ok: false; reason: "not_found" }
  | { ok: true; changed: boolean; review: Review };

/**
 * Modera uma avaliacao (admin): 'approved' ou 'rejected'. Transacional + auditada
 * (invariante 3). Idempotente: pedir o estado atual = no-op (sem audit ruidoso).
 * Aplica via compare-and-swap; recalcula o agregado do produto quando o conjunto
 * APROVADO muda (entrou em 'approved' ou saiu dele), sob lock da linha do produto.
 */
export async function setReviewStatus(
  actor: AuditActor,
  id: string,
  target: "approved" | "rejected",
  ctx?: { requestId?: string | null; ip?: string | null },
): Promise<ReviewModerationResult> {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.review.findUnique({ where: { id } });
      if (!existing) return { ok: false, reason: "not_found" } as const;

      const prev = existing.status as ReviewStatus;
      if (prev === target) {
        return { ok: true, changed: false, review: toReview(existing) } as const;
      }

      // Serializa o recalc deste produto: trava a linha ANTES do CAS. Moderacoes
      // concorrentes do MESMO produto bloqueiam aqui; a 2a re-le o agregado fresco.
      await tx.$queryRaw`SELECT "id" FROM "products" WHERE "id" = ${existing.productId}::uuid FOR UPDATE`;

      const res = await tx.review.updateMany({
        where: { id, status: prev },
        data: { status: target },
      });
      if (res.count === 0) {
        // Outra transacao moveu o status entre o read e o CAS: no-op idempotente.
        const fresh = await tx.review.findUnique({ where: { id } });
        return { ok: true, changed: false, review: toReview(fresh as ReviewModel) } as const;
      }

      // O agregado so muda se a review entrou ou saiu do conjunto 'approved'.
      if (target === "approved" || prev === "approved") {
        await recalcProductRating(tx, existing.productId);
      }

      const after = await tx.review.findUnique({ where: { id } });

      await writeAuditLog(tx, {
        actor,
        action: target === "approved" ? AuditAction.review_approve : AuditAction.review_reject,
        entityType: AuditEntityType.review,
        entityId: id,
        before: { status: prev },
        after: { status: target, productId: existing.productId, rating: existing.rating },
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
      });

      return { ok: true, changed: true, review: toReview(after as ReviewModel) } as const;
    },
    { timeout: 15000, maxWait: 5000 },
  );
}

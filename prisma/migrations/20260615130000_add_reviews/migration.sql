-- =============================================================================
-- reviews — avaliacoes de produto por cliente, COM MODERACAO.
--
-- Antes, products.rating / review_count eram decorativos (vinham do seed). Agora
-- viram DENORMALIZADOS: recalculados a partir das reviews APROVADAS na mesma
-- transacao do approve/reject (lib/data/reviews.ts), serializados por um lock na
-- linha do produto (SELECT ... FOR UPDATE), espelhando o padrao de updateProduct.
--
-- Fluxo: cliente autenticado envia (status='pending') -> admin aprova/rejeita ->
-- recalc do agregado do produto. So 'approved' aparece na vitrine.
--
-- Aditiva e segura para producao: tabela nova + ADD VALUE nos enums de auditoria
-- (PG12+ aceita em transacao desde que o valor nao seja usado na mesma transacao;
-- aqui so e declarado). IF NOT EXISTS torna os ADD VALUE reentrantes.
-- =============================================================================

-- Estende os enums de auditoria com os verbos de moderacao de review.
ALTER TYPE "AuditEntityType" ADD VALUE IF NOT EXISTS 'review';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'review.approve';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'review.reject';

-- CreateEnum: status de moderacao da avaliacao.
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'approved', 'rejected');

-- =============================================================================
-- reviews — uma avaliacao por usuario por produto (UNIQUE product_id+clerk_user_id;
-- resubmit colide em P2002 -> "voce ja avaliou"). rating 1..5 garantido por CHECK.
-- clerk_user_id por TEXTO (como orders / coupon_redemptions): sem FK real ao espelho
-- de users. product_id com FK CASCADE: apagar produto leva suas reviews junto.
-- =============================================================================
CREATE TABLE "reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id"),
    -- Nota sempre 1..5 (rede final; o app tambem valida em schema>service>component).
    CONSTRAINT "reviews_rating_chk" CHECK ("rating" BETWEEN 1 AND 5)
);

-- Anti-spam / idempotencia de autor: no maximo uma review por (produto, usuario).
CREATE UNIQUE INDEX "reviews_product_id_clerk_user_id_key" ON "reviews"("product_id", "clerk_user_id");
-- Vitrine: reviews aprovadas de um produto (lista + groupBy de distribuicao).
CREATE INDEX "reviews_product_id_status_idx" ON "reviews"("product_id", "status");
-- Moderacao: fila de pendentes no admin.
CREATE INDEX "reviews_status_idx" ON "reviews"("status");
CREATE INDEX "reviews_clerk_user_id_idx" ON "reviews"("clerk_user_id");

ALTER TABLE "reviews"
  ADD CONSTRAINT "reviews_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

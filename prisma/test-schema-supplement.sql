-- =============================================================================
-- Suplemento de schema para o BANCO DE TESTE EFEMERO.
--
-- `prisma db push` materializa tabelas/colunas/enums/FKs/indices regulares a
-- partir de schema.prisma, MAS NAO cria os CHECK constraints nem o indice
-- funcional LOWER(code) — esses vivem so no SQL versionado das migrations
-- (20260615050000_foundation_hardening). Este arquivo re-adiciona exatamente
-- esses objetos, verbatim (nomes + predicados) da migration de origem.
--
-- USO: rodar APOS `prisma db push`, contra um Postgres VANILLA descartavel.
--      NUNCA contra o Supabase compartilhado (ver memoria db-migration-state).
-- NAO inclui a migration de pg_cron (CREATE EXTENSION pg_cron/pg_net) — nenhum
-- teste precisa dela; a funcao expire_overdue_orders e instalada pelo proprio
-- tests/expiry/expire-grace.test.ts a partir da migration 20260615070000.
--
-- Idempotente: DROP ... IF EXISTS antes de cada ADD/CREATE. Seguro re-rodar.
-- =============================================================================

-- == products: invariantes do ciclo de reserva (0 <= reserved <= stock) =======
-- source: prisma/migrations/20260615050000_foundation_hardening/migration.sql:152
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_reserved_nonneg_chk";
ALTER TABLE "products" ADD  CONSTRAINT "products_reserved_nonneg_chk" CHECK ("reserved" >= 0);
-- source: ...:154
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_stock_nonneg_chk";
ALTER TABLE "products" ADD  CONSTRAINT "products_stock_nonneg_chk" CHECK ("stock" >= 0);
-- source: ...:157
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_reserved_le_stock_chk";
ALTER TABLE "products" ADD  CONSTRAINT "products_reserved_le_stock_chk" CHECK ("reserved" <= "stock");

-- == orders: abatimento de cupom nao-negativo =================================
-- source: ...:178
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_coupon_discount_cents_chk";
ALTER TABLE "orders" ADD  CONSTRAINT "orders_coupon_discount_cents_chk" CHECK ("coupon_discount_cents" >= 0);

-- == coupons: coerencia type<->campo + contadores =============================
-- source: ...:100
ALTER TABLE "coupons" DROP CONSTRAINT IF EXISTS "coupons_type_value_chk";
ALTER TABLE "coupons" ADD  CONSTRAINT "coupons_type_value_chk" CHECK (
    ("type" = 'percent' AND "percent_off" IS NOT NULL AND "percent_off" BETWEEN 1 AND 100)
    OR ("type" = 'fixed' AND "value_cents" IS NOT NULL AND "value_cents" > 0)
);
-- source: ...:104
ALTER TABLE "coupons" DROP CONSTRAINT IF EXISTS "coupons_redeemed_count_chk";
ALTER TABLE "coupons" ADD  CONSTRAINT "coupons_redeemed_count_chk" CHECK ("redeemed_count" >= 0);
-- source: ...:105
ALTER TABLE "coupons" DROP CONSTRAINT IF EXISTS "coupons_max_redemptions_chk";
ALTER TABLE "coupons" ADD  CONSTRAINT "coupons_max_redemptions_chk" CHECK ("max_redemptions" IS NULL OR "max_redemptions" >= 0);

-- == coupons: codigo unico case-insensitive (INDICE FUNCIONAL — push omite) ====
-- source: ...:109
DROP INDEX IF EXISTS "coupons_code_key";
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"(LOWER("code"));

-- == coupon_redemptions: desconto nao-negativo ================================
-- source: ...:126
ALTER TABLE "coupon_redemptions" DROP CONSTRAINT IF EXISTS "coupon_redemptions_discount_cents_chk";
ALTER TABLE "coupon_redemptions" ADD  CONSTRAINT "coupon_redemptions_discount_cents_chk" CHECK ("discount_cents" >= 0);

-- == reviews: nota 1..5 (CHECK que o push omite) ==============================
-- source: prisma/migrations/20260615130000_add_reviews/migration.sql
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_rating_chk";
ALTER TABLE "reviews" ADD  CONSTRAINT "reviews_rating_chk" CHECK ("rating" BETWEEN 1 AND 5);

-- == rate_limit_hits: contador de janela positivo (CHECK que o push omite) =====
-- source: prisma/migrations/20260706120000_add_rate_limit_hits/migration.sql
-- (NAO inclui pg_cron nem storage params — o PG efemero nao tem pg_cron e vive
--  segundos; ambos ficam so na migration.)
ALTER TABLE "rate_limit_hits" DROP CONSTRAINT IF EXISTS "rate_limit_hits_hit_count_pos_chk";
ALTER TABLE "rate_limit_hits" ADD  CONSTRAINT "rate_limit_hits_hit_count_pos_chk" CHECK ("hit_count" >= 1);

-- == categories: seed do conjunto canonico (DADO que o push NAO materializa) ====
-- source: prisma/migrations/20260710120000_seed_categories/migration.sql
-- Desde o acoplamento por nome (2026-07-10) createProduct/updateProduct VALIDAM a
-- categoria contra a tabela `categories`. O seed vive numa MIGRATION (nao no
-- schema.prisma), entao `prisma db push` nao o executa — sem isto, todo teste que
-- cria produto via createProduct falharia no banco efemero. Idempotente.
INSERT INTO "categories" ("id", "name", "updated_at")
VALUES
  (gen_random_uuid(), 'Booster Box', now()),
  (gen_random_uuid(), 'Elite Trainer Box', now()),
  (gen_random_uuid(), 'Booster Pack', now()),
  (gen_random_uuid(), 'Blister Triplo', now()),
  (gen_random_uuid(), 'Blister Quadruplo', now()),
  (gen_random_uuid(), 'Coleção Especial', now()),
  (gen_random_uuid(), 'Tin', now()),
  (gen_random_uuid(), 'Acessórios', now()),
  (gen_random_uuid(), 'Single Card', now())
ON CONFLICT ("name") DO NOTHING;

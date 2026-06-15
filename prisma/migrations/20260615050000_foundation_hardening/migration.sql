-- =============================================================================
-- FUNDACAO / HARDENING — RM Cards
-- Dinheiro SEMPRE Int de centavos (*_cents). DB snake_case. Timestamptz(6).
-- pg_cron NAO entra aqui (workstream pgcron). Schema deixado compativel.
-- =============================================================================

-- CreateEnum: tipo de entidade auditavel (extensivel; valores estaveis).
CREATE TYPE "AuditEntityType" AS ENUM ('product', 'order', 'coupon', 'user');

-- CreateEnum: acao auditada (verbo de dominio, nao CRUD cru).
CREATE TYPE "AuditAction" AS ENUM (
  'product.create',
  'product.update',
  'product.inactivate',
  'product.reactivate',
  'product.delete',
  'order.payment_status_update',
  'order.shipping_status_update',
  'order.note_update',
  'coupon.create',
  'coupon.update',
  'coupon.deactivate'
);

-- CreateEnum: tipo de desconto do cupom.
CREATE TYPE "CouponType" AS ENUM ('percent', 'fixed');

-- =============================================================================
-- audit_log — trilha imutavel de toda mutacao de admin (invariante 3).
-- Gravado na MESMA transacao da mutacao via writeAuditLog(tx, {...}).
-- before/after: snapshot jsonb do dominio (camelCase, *Cents inteiros).
-- =============================================================================
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_clerk_user_id" TEXT,
    "actor_email" TEXT,
    "actor_role" "Role",
    "action" "AuditAction" NOT NULL,
    "entity_type" "AuditEntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");
CREATE INDEX "audit_log_actor_clerk_user_id_idx" ON "audit_log"("actor_clerk_user_id");

-- =============================================================================
-- webhook_events — ledger de eventos de provedores (Asaas hoje, extensivel).
-- (provider, event_id) unico => barra reprocessamento alem do anti-replay atual.
-- processed_at NULL = recebido mas ainda nao concluido (reentrada segura).
-- =============================================================================
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");
CREATE INDEX "webhook_events_processed_at_idx" ON "webhook_events"("processed_at");

-- =============================================================================
-- coupons — cupom de desconto (workstream coupon).
-- value_cents: usado quando type='fixed' (centavos). percent_off: quando 'percent'.
-- min_subtotal_cents: piso de mercadoria (subtotal - desconto de produto).
-- max_redemptions NULL = ilimitado; per_user_limit NULL = sem limite por usuario.
-- redeemed_count: contador denormalizado, incrementado atomicamente na redencao.
-- =============================================================================
CREATE TABLE "coupons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "type" "CouponType" NOT NULL,
    "percent_off" INTEGER,
    "value_cents" INTEGER,
    "min_subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "max_redemptions" INTEGER,
    "per_user_limit" INTEGER,
    "redeemed_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id"),
    -- Coerencia tipo<->campo: percent precisa de percent_off; fixed precisa de value_cents.
    CONSTRAINT "coupons_type_value_chk" CHECK (
        ("type" = 'percent' AND "percent_off" IS NOT NULL AND "percent_off" BETWEEN 1 AND 100)
        OR ("type" = 'fixed' AND "value_cents" IS NOT NULL AND "value_cents" > 0)
    ),
    CONSTRAINT "coupons_redeemed_count_chk" CHECK ("redeemed_count" >= 0),
    CONSTRAINT "coupons_max_redemptions_chk" CHECK ("max_redemptions" IS NULL OR "max_redemptions" >= 0)
);

-- code unico case-insensitive (cupom 'BEMVINDO' == 'bemvindo').
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"(LOWER("code"));
CREATE INDEX "coupons_is_active_idx" ON "coupons"("is_active");

-- =============================================================================
-- coupon_redemptions — uma linha por uso efetivo, vinculada ao pedido.
-- Idempotente por order (UNIQUE order_id): redimir o mesmo pedido 2x = no-op.
-- discount_cents: quanto o cupom efetivamente abateu (recalculado no server).
-- =============================================================================
CREATE TABLE "coupon_redemptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "coupon_id" UUID NOT NULL,
    "order_id" INTEGER NOT NULL,
    "clerk_user_id" TEXT NOT NULL,
    "discount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coupon_redemptions_discount_cents_chk" CHECK ("discount_cents" >= 0)
);

-- Idempotencia: no maximo uma redencao por pedido.
CREATE UNIQUE INDEX "coupon_redemptions_order_id_key" ON "coupon_redemptions"("order_id");
CREATE INDEX "coupon_redemptions_coupon_id_idx" ON "coupon_redemptions"("coupon_id");
CREATE INDEX "coupon_redemptions_clerk_user_id_idx" ON "coupon_redemptions"("clerk_user_id");

ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey"
  FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- products: reserva de estoque sem corrida.
-- 'stock' = estoque fisico. 'reserved' = unidades comprometidas por pedidos
-- pendentes (reservadas no checkout, estornadas no cancelamento/expiracao,
-- baixadas de stock na confirmacao do pagamento).
-- Disponivel para venda = stock - reserved. Invariantes garantidas por CHECK.
-- =============================================================================
ALTER TABLE "products" ADD COLUMN "reserved" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "products"
  ADD CONSTRAINT "products_reserved_nonneg_chk" CHECK ("reserved" >= 0);
ALTER TABLE "products"
  ADD CONSTRAINT "products_stock_nonneg_chk" CHECK ("stock" >= 0);
-- Nunca reservar alem do estoque fisico.
ALTER TABLE "products"
  ADD CONSTRAINT "products_reserved_le_stock_chk" CHECK ("reserved" <= "stock");

-- =============================================================================
-- orders: idempotencia de checkout, cupom e ciclo de reserva de estoque.
-- checkout_key: chave estavel por tentativa de checkout (UNIQUE) => recriar o
--   mesmo carrinho/sessao reaproveita o pedido em vez de duplicar cobranca.
-- coupon_code / coupon_discount_cents: cupom aplicado (codigo + abatimento).
--   NOTE: discount_cents (existente) = desconto de PRODUTO; coupon_discount_cents
--   = desconto de CUPOM. total = subtotal - discount_cents - coupon_discount_cents + frete.
-- stock_reserved / stock_committed: marcas idempotentes do ciclo de estoque.
-- =============================================================================
ALTER TABLE "orders" ADD COLUMN "checkout_key" TEXT;
ALTER TABLE "orders" ADD COLUMN "coupon_code" TEXT;
ALTER TABLE "orders" ADD COLUMN "coupon_discount_cents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "stock_reserved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "stock_committed" BOOLEAN NOT NULL DEFAULT false;
-- Vencimento do PIX: fonte unica para o pg_cron expirar pedidos pending (derivado
-- de PIX_DUE_DAYS no checkout). Null em pedidos legados/sem cobranca.
ALTER TABLE "orders" ADD COLUMN "due_date" TIMESTAMPTZ(6);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_coupon_discount_cents_chk" CHECK ("coupon_discount_cents" >= 0);

-- Idempotencia de checkout: chave unica vinculada ao pedido (NULLs nao colidem).
CREATE UNIQUE INDEX "orders_checkout_key_key" ON "orders"("checkout_key");
CREATE INDEX "orders_payment_status_idx" ON "orders"("payment_status");
CREATE INDEX "orders_stock_reserved_idx" ON "orders"("stock_reserved");

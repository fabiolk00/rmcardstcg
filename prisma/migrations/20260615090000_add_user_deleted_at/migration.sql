-- =============================================================================
-- Soft-delete do espelho de usuario (item #4 do AUDIT).
--
-- O evento user.deleted do Clerk passa a MARCAR a linha como deletada em vez de
-- apaga-la. Pedidos (orders) e redencoes (coupon_redemptions) referenciam o
-- usuario por clerk_user_id em TEXTO (sem FK real); apagar a linha do espelho
-- deixaria esse historico sem o registro de usuario correspondente. O soft-delete
-- preserva o historico e remove o acesso (getUserRole filtra deletedAt IS NULL).
-- =============================================================================

-- AlterTable
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

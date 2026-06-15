-- =============================================================================
-- Acao de auditoria coupon.delete.
--
-- O CRUD de cupom passa a permitir EXCLUSAO permanente (alem de inativar). Como
-- toda mutacao de admin grava audit_log na MESMA transacao (invariante 3), o
-- enum AuditAction ganha o valor 'coupon.delete' para registrar a exclusao
-- (before = snapshot do cupom; after = null).
--
-- ALTER TYPE ... ADD VALUE roda fora de transacao (restricao do Postgres); o
-- runner do Prisma trata este caso. Idempotente via IF NOT EXISTS.
-- =============================================================================

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'coupon.delete';

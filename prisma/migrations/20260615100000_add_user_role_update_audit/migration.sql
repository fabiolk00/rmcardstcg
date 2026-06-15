-- =============================================================================
-- Acao de auditoria user.role_update (item #3 do AUDIT).
--
-- O admin ganha uma acao EXPLICITA e AUDITADA para alterar a role de um usuario
-- (setUserRole). Como toda mutacao de admin grava audit_log na MESMA transacao
-- (invariante 3), o enum AuditAction ganha o valor 'user.role_update' (before =
-- { role anterior }; after = { role nova }).
--
-- ALTER TYPE ... ADD VALUE roda fora de transacao (restricao do Postgres) e NUNCA
-- pode ser usado na mesma transacao em que e criado; por isso fica isolado neste
-- arquivo de migration proprio. Idempotente via IF NOT EXISTS.
-- =============================================================================

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'user.role_update';

-- =============================================================================
-- Rastreio de envio no pedido (tracking_code + shipping_carrier).
--
-- O admin preenche ao despachar; o cliente vê o código + link do transportador no
-- detalhe do pedido (Minhas Compras). carrier = id do transportador (lib/data/
-- carriers.ts); tracking_code = código do objeto. Ambos nullable (pedidos legados
-- / sem envio). Aditiva e segura para produção: colunas nullable sem default são
-- metadata-only (sem reescrita de tabela, sem lock pesado).
-- =============================================================================

-- Verbo de auditoria do preenchimento de rastreio (admin). PG12+ aceita ADD VALUE
-- em transação desde que o valor não seja usado na mesma tx; IF NOT EXISTS reentrante.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'order.tracking_update';

ALTER TABLE "orders"
  ADD COLUMN "tracking_code" TEXT,
  ADD COLUMN "shipping_carrier" TEXT;

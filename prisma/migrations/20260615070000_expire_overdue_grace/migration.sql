-- =============================================================================
-- Grace window no expire-overdue (fecha a corrida com a reconciliacao).
--
-- Achado CRITICO (billing): expire_overdue_orders() cancelava + estornava
-- qualquer pedido 'pending' com due_date < now(), SEM consultar o Asaas. Se o
-- cliente pagava perto do vencimento e o webhook falhava/atrasava, o pedido era
-- cancelado; o reconcile (que so toca 'pending' e consulta o Asaas) entao o
-- ignorava -> dinheiro recebido, estoque liberado, sem recuperacao.
--
-- Fix: so expira pedidos vencidos ha MAIS de 60 min. Como o reconcile roda a
-- cada 10 min e consulta o status real no Asaas, a janela garante que um
-- pagamento tardio seja reconciliado (e o pedido saia de 'pending') ANTES de
-- ficar elegivel a expiracao cega. CREATE OR REPLACE: o cron.schedule do
-- 060000_pgcron chama a funcao por nome, entao nao precisa reagendar.
-- =============================================================================

CREATE OR REPLACE FUNCTION expire_overdue_orders()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_expired integer := 0;
BEGIN
  WITH cancelled AS (
    UPDATE "orders" AS o
    SET
      "payment_status"  = 'cancelled',
      "shipping_status" = 'cancelled',
      "stock_reserved"  = false
    WHERE o."payment_status" = 'pending'
      AND o."due_date" IS NOT NULL
      AND o."due_date" < now() - interval '60 minutes'
      AND o."stock_reserved" = true
    RETURNING o."id"
  ),
  released AS (
    UPDATE "products" AS p
    SET "reserved" = p."reserved" - agg."qty"
    FROM (
      SELECT oi."product_id" AS pid, SUM(oi."quantity")::integer AS qty
      FROM "order_items" oi
      JOIN cancelled c ON c."id" = oi."order_id"
      GROUP BY oi."product_id"
    ) AS agg
    WHERE p."id" = agg.pid
      AND p."reserved" >= agg."qty"
    RETURNING p."id"
  )
  SELECT count(*)::integer INTO v_expired FROM cancelled;

  -- Pedidos vencidos SEM reserva ativa (legados / ja estornados): so coerencia de
  -- status. Mesma janela de graca. Idempotente (so atinge pending).
  UPDATE "orders" AS o
  SET "payment_status" = 'cancelled', "shipping_status" = 'cancelled'
  WHERE o."payment_status" = 'pending'
    AND o."due_date" IS NOT NULL
    AND o."due_date" < now() - interval '60 minutes'
    AND o."stock_reserved" = false;

  RETURN v_expired;
END;
$$;

COMMENT ON FUNCTION expire_overdue_orders() IS
  'Job pg_cron: cancela pedidos pending com PIX vencido ha >60min (grace window > intervalo do reconcile, p/ nao cancelar pedido pago cujo webhook atrasou) e estorna a reserva de estoque idempotentemente via stock_reserved. Coexiste com releaseStock do billing sem estorno duplo.';

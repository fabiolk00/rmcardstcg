-- =============================================================================
-- pg_cron / pg_net — RM Cards (workstream pgcron)
-- Depende da FUNDACAO (20260615050000_foundation_hardening): usa
--   products.reserved / products.stock + orders.stock_reserved (ciclo de reserva)
--   orders.due_date (vencimento do PIX, fonte unica — Q6)
--   coupons.is_active / coupons.expires_at
--   webhook_events.processed_at (retencao; audit_log NAO e purgado — Q5)
-- Dinheiro em centavos. snake_case. Timestamptz(6). pg_cron VIVE so aqui.
--
-- ONDE RODAR: pg_cron precisa existir no banco do scheduler (no Supabase, o
-- database 'postgres'). Esta migracao roda via DIRECT_URL (5432) — correto p/ DDL.
--
-- SEGREDOS — NUNCA hardcodar: o job de reconciliacao (3) le URL e segredo de GUCs
-- do banco (app.settings.*), definidos UMA vez no Supabase (fora do git):
--   ALTER DATABASE postgres SET app.settings.reconcile_url    = 'https://SEU_HOST/api/internal/reconcile-orders';
--   ALTER DATABASE postgres SET app.settings.reconcile_secret = '<CRON_RECONCILE_SECRET>';
-- Sem essas GUCs, o job (3) e NO-OP seguro (loga aviso) — fail-closed.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- -----------------------------------------------------------------------------
-- FUNCAO 1: expire_overdue_orders()
-- Cancela pedidos 'pending' cujo PIX venceu (orders.due_date < now()) e ESTORNA a
-- reserva de estoque, nativamente, em UMA transacao (a funcao roda atomicamente).
-- Usa orders.due_date (Q6) como fonte unica — sem hardcode de PIX_DUE_DAYS no SQL.
-- COEXISTENCIA COM BILLING: so toca payment_status='pending'; o estorno e guardado
-- por orders.stock_reserved (mesma flag do releaseStock do billing); o flip
-- stock_reserved=false no MESMO UPDATE garante estorno unico. IDEMPOTENTE.
-- -----------------------------------------------------------------------------
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
      AND o."due_date" < now()
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
  -- status, sem mexer em estoque. Idempotente (so atinge pending).
  UPDATE "orders" AS o
  SET "payment_status" = 'cancelled', "shipping_status" = 'cancelled'
  WHERE o."payment_status" = 'pending'
    AND o."due_date" IS NOT NULL
    AND o."due_date" < now()
    AND o."stock_reserved" = false;

  RETURN v_expired;
END;
$$;

COMMENT ON FUNCTION expire_overdue_orders() IS
  'Job pg_cron: cancela pedidos pending com PIX vencido (orders.due_date < now()) e estorna reserva de estoque (products.reserved) de forma idempotente via flag orders.stock_reserved. Coexiste com releaseStock do billing sem estorno duplo.';

-- -----------------------------------------------------------------------------
-- FUNCAO 2: deactivate_expired_coupons() — is_active=false p/ cupons vencidos.
-- IDEMPOTENTE (WHERE is_active=true).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION deactivate_expired_coupons()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH updated AS (
    UPDATE "coupons"
    SET "is_active" = false, "updated_at" = now()
    WHERE "is_active" = true
      AND "expires_at" IS NOT NULL
      AND "expires_at" < now()
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM updated;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION deactivate_expired_coupons() IS
  'Job pg_cron: desativa (is_active=false) cupons com expires_at < now(). Idempotente.';

-- -----------------------------------------------------------------------------
-- FUNCAO 3: trigger_order_reconciliation()
-- NAO faz billing no SQL. Dispara POST (pg_net) para /api/internal/reconcile-orders
-- com header secreto (GUC app.settings.reconcile_secret). NO-OP seguro se as GUCs
-- nao existirem (fail-closed). Efeito real e idempotente (CAS em setOrderPaymentStatus).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_order_reconciliation()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_url    text := current_setting('app.settings.reconcile_url', true);
  v_secret text := current_setting('app.settings.reconcile_secret', true);
BEGIN
  IF v_url IS NULL OR v_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING '[pgcron] reconciliacao ignorada: app.settings.reconcile_url/secret nao definidos.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret
    ),
    body    := jsonb_build_object('source', 'pg_cron', 'job', 'reconcile-pending-orders'),
    timeout_milliseconds := 25000
  );
END;
$$;

COMMENT ON FUNCTION trigger_order_reconciliation() IS
  'Job pg_cron: dispara POST (pg_net) para /api/internal/reconcile-orders com header secreto (GUC). Billing fica no TS; SQL so chama o gatilho. NO-OP se as GUCs nao existirem.';

-- -----------------------------------------------------------------------------
-- FUNCAO 4: purge_processed_webhook_events()
-- Retencao: remove webhook_events PROCESSADOS ha mais de 90 dias. O audit_log NAO
-- e purgado (trilha imutavel — decisao Q5). IDEMPOTENTE (delete por janela).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_processed_webhook_events()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH d AS (
    DELETE FROM "webhook_events"
    WHERE "processed_at" IS NOT NULL
      AND "processed_at" < (now() - interval '90 days')
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM d;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION purge_processed_webhook_events() IS
  'Job pg_cron: apaga webhook_events processados >90d. NAO toca audit_log (imutavel, Q5). Idempotente por janela de tempo.';

-- =============================================================================
-- AGENDAMENTO DOS JOBS (cron.schedule). Reagendamento idempotente: unschedule por
-- nome antes de (re)criar (envolto em DO/EXCEPTION p/ nao falhar se nao existir).
--
-- Frequencias (UTC — pg_cron usa o fuso do servidor):
--   rmcards-expire-overdue-orders     : a cada 15 min
--   rmcards-deactivate-expired-coupons: 1x/hora (minuto 5)
--   rmcards-reconcile-pending-orders  : a cada 10 min
--   rmcards-purge-webhook-events      : diario 03:30
--
-- DESLIGAR um job: SELECT cron.unschedule('rmcards-expire-overdue-orders');
-- INSPECIONAR:
--   SELECT jobid, schedule, jobname, active, command FROM cron.job WHERE jobname LIKE 'rmcards-%';
--   SELECT * FROM cron.job_run_details
--     WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'rmcards-%')
--     ORDER BY start_time DESC LIMIT 50;
-- =============================================================================

DO $$ BEGIN PERFORM cron.unschedule('rmcards-expire-overdue-orders');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('rmcards-deactivate-expired-coupons');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('rmcards-reconcile-pending-orders');
EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('rmcards-purge-webhook-events');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- Job 1: expirar pedidos pending vencidos + estornar estoque. A cada 15 min.
SELECT cron.schedule(
  'rmcards-expire-overdue-orders',
  '*/15 * * * *',
  $cron$ SELECT expire_overdue_orders(); $cron$
);

-- Job 2: desativar cupons expirados. 1x/hora, no minuto 5.
SELECT cron.schedule(
  'rmcards-deactivate-expired-coupons',
  '5 * * * *',
  $cron$ SELECT deactivate_expired_coupons(); $cron$
);

-- Job 3: reconciliacao de pedidos pending (dispara rota interna via pg_net). 10 min.
SELECT cron.schedule(
  'rmcards-reconcile-pending-orders',
  '*/10 * * * *',
  $cron$ SELECT trigger_order_reconciliation(); $cron$
);

-- Job 4: retencao de webhook_events processados. Diario 03:30 UTC.
SELECT cron.schedule(
  'rmcards-purge-webhook-events',
  '30 3 * * *',
  $cron$ SELECT purge_processed_webhook_events(); $cron$
);

-- =============================================================================
-- rate_limit_hits — contador de JANELA FIXA do RateLimitStore COMPARTILHADO
-- (serverless multi-instancia; injetado em prod via setRateLimitStore no boot,
-- ver instrumentation.ts). Uma linha por (key, window_start); cada hit e um
-- UPSERT atomico (INSERT .. ON CONFLICT DO UPDATE hit_count+1 RETURNING) — 1
-- round-trip; incrementos subsequentes sao HOT updates (hit_count NAO e indexado).
-- NAO e dado de dominio (sem centavos); podado por pg_cron (funcao + schedule
-- VIVEM so aqui — o Postgres de teste efemero nao tem pg_cron).
--
-- Nomes de PK/indice = os que o Prisma gera do model RateLimitHit (drift-clean vs
-- `prisma db push`). pg_cron ja foi criado em 20260615060000_pgcron (migrations
-- rodam em ordem de timestamp; NAO recriar a extensao, NAO backportar esta
-- migration antes daquela).
-- =============================================================================

CREATE TABLE "rate_limit_hits" (
    "key"          TEXT           NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "hit_count"    INTEGER        NOT NULL DEFAULT 1,
    "expires_at"   TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_limit_hits_pkey" PRIMARY KEY ("key", "window_start")
);

-- Poda por tempo (pg_cron DELETE WHERE expires_at < now()) via index-scan; NAO
-- cobre hit_count -> os incrementos ficam HOT (sem manutencao de indice no hot path).
CREATE INDEX "rate_limit_hits_expires_at_idx" ON "rate_limit_hits" ("expires_at");

-- Invariante defensivo. `db push` OMITE CHECK -> espelhado VERBATIM no
-- test-schema-supplement.sql. hit_count comeca em 1 e so incrementa/satura => >= 1.
ALTER TABLE "rate_limit_hits"
  ADD CONSTRAINT "rate_limit_hits_hit_count_pos_chk" CHECK ("hit_count" >= 1);

-- Storage tuning que schema.prisma NAO expressa (SO na migration; o PG efemero vive
-- segundos e nao precisa). fillfactor<100 deixa folga na pagina p/ o incremento
-- continuar HOT update; autovacuum agressivo contem o bloat de update+delete.
ALTER TABLE "rate_limit_hits"
  SET (fillfactor = 70,
       autovacuum_vacuum_scale_factor = 0.02,
       autovacuum_analyze_scale_factor = 0.05);

-- ---- pg_cron: poda (SO aqui; o test DB nao tem pg_cron) ----------------------
-- expires_at = window_start + janela, entao uma linha vira podavel quando a janela
-- termina. Espelha purge_processed_webhook_events(): RETURNS integer, count(*)::integer.
CREATE OR REPLACE FUNCTION prune_rate_limit_hits()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH d AS (
    DELETE FROM "rate_limit_hits"
    WHERE "expires_at" < now()          -- usa rate_limit_hits_expires_at_idx
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM d;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION prune_rate_limit_hits() IS
  'Job pg_cron: apaga janelas de rate limit expiradas (expires_at < now()). Idempotente por janela de tempo.';

-- Reagendamento idempotente (unschedule por nome antes de recriar), padrao do 060000_pgcron.
DO $$ BEGIN
  PERFORM cron.unschedule('rmcards-prune-rate-limit-hits');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'rmcards-prune-rate-limit-hits',
  '*/5 * * * *',
  $cron$ SELECT prune_rate_limit_hits(); $cron$
);

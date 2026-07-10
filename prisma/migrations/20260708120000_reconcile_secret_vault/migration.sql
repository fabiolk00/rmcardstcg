-- =============================================================================
-- trigger_order_reconciliation() — troca GUC por Supabase Vault.
--
-- Achado (sessao pgcron-followup): `ALTER DATABASE postgres SET app.settings.*`
-- (a forma original, ver 20260615060000_pgcron) exige privilegio de superuser/
-- dono do banco. No Supabase hospedado, NEM o SQL Editor do painel tem esse
-- privilegio (confirmado: 42501 permission denied, tanto ALTER DATABASE quanto
-- ALTER FUNCTION ... SET). Ou seja, as GUCs nunca puderam ser configuradas -> a
-- reconciliacao ficou NO-OP silencioso desde o dia 1 (fail-closed, sem dano, mas
-- sem a rede de seguranca contra webhook perdido).
--
-- Fix: le os segredos do Supabase Vault (extensao supabase_vault, jah habilitada
-- no projeto) via `vault.decrypted_secrets`, em vez de `current_setting()`. Vault
-- e uma tabela/view normal (INSERT/SELECT), nao GUC persistente -> nao exige
-- superuser, so a permissao normal do role que ja roda as migrations.
--
-- Os VALORES (reconcile_url e reconcile_secret) NAO vao nesta migration (CI/git).
-- Sao inseridos uma vez via `select vault.create_secret(valor, nome)`, fora do
-- git, igual ao espirito original ("SEGREDOS - NUNCA hardcodar"). Sem os 2
-- secrets nomeados 'reconcile_url'/'reconcile_secret' no vault, a funcao segue
-- NO-OP seguro (RAISE WARNING) — mesmo fail-closed de antes.
-- =============================================================================

CREATE OR REPLACE FUNCTION trigger_order_reconciliation()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_url    text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets WHERE name = 'reconcile_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets WHERE name = 'reconcile_secret' LIMIT 1;

  IF v_url IS NULL OR v_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING '[pgcron] reconciliacao ignorada: segredos reconcile_url/reconcile_secret nao encontrados no Vault.';
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
  'Job pg_cron: dispara POST (pg_net) para /api/internal/reconcile-orders com header secreto lido do Supabase Vault (vault.decrypted_secrets, nomes reconcile_url/reconcile_secret). NO-OP seguro se os secrets nao existirem no vault. Substitui a variante original por GUC (app.settings.*), que exigia superuser indisponivel no Supabase hospedado.';

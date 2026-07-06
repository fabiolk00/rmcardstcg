// RateLimitStore COMPARTILHADO (Postgres) — janela FIXA.
//
// O default em memoria (lib/security/rateLimit.ts) e por-instancia: em serverless
// multi-instancia (Vercel) cada Lambda tem o proprio contador, entao o teto real
// vira M*limit sob M instancias. Este store guarda a contagem no Postgres, entao
// TODAS as instancias compartilham a janela. Injetado no boot em prod
// (instrumentation.ts) via setRateLimitStore.
//
// Uma linha por (key, window_start); cada hit e um UPSERT atomico (1 round-trip)
// cujo RETURNING e "quantos hits caem na janela atual" — o contrato exato de hit().
// Janela fixa admite ate ~2x o limite numa virada de janela (aceitavel p/ limites
// de 5..30/min de abuso autenticado; o caminho de dinheiro tem idempotencia
// propria: checkout_key unico, CHECKs de estoque, idempotencia do PIX).
//
// FOLLOW-UP operacional (nao-bloqueante): num incidente de "DB conecta mas toda
// query lenta", o timeout de cliente ABRE em 500ms mas a query orfa segue segurando
// a conexao do pool COMPARTILHADO (adapter-pg nao cancela) ate o server terminar —
// pressao no mesmo pool do checkout. Mitigacao futura: pool dedicado do limiter com
// statement_timeout ~500ms (isola o dominio de falha). Fail-open ja evita 500 aqui.

import { Prisma } from "../generated/prisma/client";
import type { PrismaClient } from "../generated/prisma/client";

import type { RateLimitStore } from "./rateLimit";

// Sentinela de FAIL-OPEN. checkRateLimit faz `allowed = count <= limit`; TODO
// limit configurado e > 0 (hoje 5..30) e 0 e IMPOSSIVEL no caminho de sucesso (o
// primeiro hit real retorna 1), entao devolver 0 SEMPRE permite e marca de forma
// unica "DB indisponivel, liberado por fail-open". Um soluco do rate limiter
// jamais pode virar 500 no checkout.
const FAIL_OPEN = 0;
const DEFAULT_TIMEOUT_MS = 500;

// Anti-spam do log de fail-open: num outage, hit() abriria em TODA request; logamos
// no maximo uma vez por acao a cada WARN_THROTTLE_MS (janela por instancia).
const WARN_THROTTLE_MS = 10_000;
const lastWarnAt = new Map<string, number>();

function warnFailOpen(action: string): void {
  const now = Date.now();
  if (now - (lastWarnAt.get(action) ?? 0) < WARN_THROTTLE_MS) return;
  lastWarnAt.set(action, now);
  console.warn(`[rateLimit] fail-open (Postgres indisponivel/lento): ${action}`);
}

type RawClient = Pick<PrismaClient, "$queryRaw">;

/**
 * Store de rate limit COMPARTILHADO (Postgres), injetado no boot em prod via
 * setRateLimitStore. `client` e obrigatorio: o boot passa o `prisma` singleton; o
 * teste de concorrencia passa um prisma ligado ao Postgres efemero.
 * `opts.timeoutMs` e o teto de latencia por chamada (default 500ms).
 */
export function createPostgresRateLimitStore(
  client: RawClient,
  opts: { timeoutMs?: number } = {},
): RateLimitStore {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async hit(key: string, windowMs: number): Promise<number> {
      // UPSERT atomico: a CTE `p` amarra windowMs uma vez; `w` deriva window_start
      // e expires_at do MESMO bucket (now() do DB = relogio unico p/ todas as
      // instancias). ON CONFLICT re-le a linha existente sob row-lock, entao N hits
      // concorrentes na mesma janela serializam sem perder update (sem CAS de app).
      // ::int no RETURNING evita o landmine de BigInt do driver. Construimos a query
      // DENTRO do .then p/ que um throw SINCRONO (ex.: $queryRaw ausente) tambem caia
      // no fail-open, nao so a rejeicao assincrona.
      const run = Promise.resolve()
        .then(() =>
          client.$queryRaw<{ hit_count: number }[]>(
            Prisma.sql`
              WITH p AS (SELECT ${windowMs}::float8 / 1000.0 AS win_s),
              w AS (
                SELECT to_timestamp(floor(extract(epoch FROM now()) / p.win_s) * p.win_s) AS window_start,
                       p.win_s
                FROM p
              )
              INSERT INTO "rate_limit_hits" AS r ("key", "window_start", "hit_count", "expires_at")
              SELECT ${key}, w.window_start, 1, w.window_start + make_interval(secs => w.win_s)
              FROM w
              ON CONFLICT ("key", "window_start")
              DO UPDATE SET "hit_count" =
                -- incremento SATURANTE: para num teto muito acima de qualquer limit
                -- (5..30) -> nunca estoura int4 sob ataque; hit_count>limit segue
                -- => allowed=false.
                CASE WHEN r."hit_count" < 1000000 THEN r."hit_count" + 1 ELSE r."hit_count" END
              RETURNING r."hit_count"::int AS hit_count
            `,
          ),
        )
        .then((rows) => {
          const n = rows[0]?.hit_count;
          return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : FAIL_OPEN;
        })
        // DB fora / pool exausto / connreset / shape inesperado / throw sincrono => ABRE.
        .catch(() => FAIL_OPEN);

      // DB lento => ABRE sem travar o checkout. withTimeout RESOLVE o fallback
      // (nunca rejeita) e engole a rejeicao tardia da query orfa.
      const count = await withTimeout(run, timeoutMs, FAIL_OPEN);

      if (count === FAIL_OPEN) {
        // Visibilidade (throttled): um outage do DB desliga o limiter em silencio.
        // Loga so o segmento de acao (antes do ':'), nunca a key inteira (pode ter PII).
        warnFailOpen(key.split(":")[0]);
      }
      return count;
    },
  };
}

/** Resolve `fallback` se `p` nao assentar em `ms`; engole rejeicao tardia (sem unhandledRejection). */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    timer.unref?.(); // o timer sozinho nao segura o event loop (serverless).
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkRateLimit, type RateLimitStore } from "../../lib/security/rateLimit";
import { createPostgresRateLimitStore } from "../../lib/security/pgRateLimitStore";

// -----------------------------------------------------------------------------
// FAIL-OPEN (DB-free) — a propriedade mais critica: um rate limiter jamais pode
// virar 500 no checkout. Roda sempre (`vitest run`), com client falso.
// -----------------------------------------------------------------------------
describe("createPostgresRateLimitStore — fail-open (DB-free)", () => {
  it("erro do Postgres => hit() resolve 0 (nao lanca) e a request e PERMITIDA", async () => {
    const client = { $queryRaw: () => Promise.reject(new Error("boom")) };
    const store = createPostgresRateLimitStore(client as never);

    await expect(store.hit("checkout:x", 60_000)).resolves.toBe(0);
    const r = await checkRateLimit("checkout:x", { limit: 12, windowMs: 60_000 }, store);
    expect(r.allowed).toBe(true);
  });

  it("Postgres lento (nunca resolve) => timeout curto ABRE (0) sem travar", async () => {
    const client = { $queryRaw: () => new Promise(() => {}) }; // pendura pra sempre
    const store = createPostgresRateLimitStore(client as never, { timeoutMs: 50 });

    const start = Date.now();
    await expect(store.hit("checkout:x", 60_000)).resolves.toBe(0);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("shape inesperado (sem linha) => 0 (fail-open), nunca NaN/undefined", async () => {
    const client = { $queryRaw: () => Promise.resolve([]) };
    const store = createPostgresRateLimitStore(client as never);

    await expect(store.hit("checkout:x", 60_000)).resolves.toBe(0);
  });
});

// -----------------------------------------------------------------------------
// CONCORRENCIA (Postgres real) — prova de atomicidade do UPSERT. Opt-in via
// TEST_DATABASE_URL (use `pnpm test:db`). Exercita a funcao REAL contra o Postgres
// efemero (tabela criada por `db push`, CHECK pelo supplement).
// -----------------------------------------------------------------------------
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  "createPostgresRateLimitStore — Postgres real (concorrencia, atomicidade)",
  () => {
    let prisma: {
      $queryRaw: (...args: unknown[]) => Promise<unknown>;
      $disconnect: () => Promise<void>;
    };
    let store: RateLimitStore;

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      prisma = (await import("../../lib/db")).prisma as never;
      store = createPostgresRateLimitStore(prisma as never);
    });

    afterAll(async () => {
      if (prisma) await prisma.$disconnect();
    });

    function freshKey(): string {
      return `test:${randomUUID()}`;
    }

    async function sumFor(key: string): Promise<number> {
      // COALESCE(...,0)::int -> sempre number, nunca BigInt/null. `${key}` num
      // tagged-template do $queryRaw e parametrizado (seguro).
      const rows = (await prisma.$queryRaw`
        SELECT COALESCE(sum("hit_count"), 0)::int AS s FROM "rate_limit_hits" WHERE "key" = ${key}
      `) as { s: number }[];
      return rows[0].s;
    }

    async function rowCount(key: string): Promise<number> {
      const rows = (await prisma.$queryRaw`
        SELECT count(*)::int AS c FROM "rate_limit_hits" WHERE "key" = ${key}
      `) as { c: number }[];
      return rows[0].c;
    }

    it("sequencial: hit() sobe monotonicamente e checkRateLimit corta apos o limite", async () => {
      const key = freshKey();
      const seen: number[] = [];
      for (let i = 0; i < 7; i += 1) seen.push(await store.hit(key, 60_000));
      // Straddle-robust: os 7 hits foram contados (soma == 7). O padrao exato 1..7
      // so vale se tudo caiu numa janela (rowCount==1) — mesma guarda do teste de
      // concorrencia, p/ nao flakar quando os round-trips cruzam a borda do minuto.
      expect(await sumFor(key)).toBe(7);
      if ((await rowCount(key)) === 1) {
        expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
      }

      const key2 = freshKey();
      const allowed: boolean[] = [];
      for (let i = 0; i < 7; i += 1) {
        allowed.push((await checkRateLimit(key2, { limit: 5, windowMs: 60_000 }, store)).allowed);
      }
      // Janela unica: 5 permitidos, depois corta. Num straddle raro a contagem
      // reinicia (mais permitidos), mas nunca MENOS de 5 -> so afirmamos o padrao
      // exato quando foi uma janela.
      if ((await rowCount(key2)) === 1) {
        expect(allowed).toEqual([true, true, true, true, true, false, false]);
      } else {
        expect(allowed.filter(Boolean).length).toBeGreaterThanOrEqual(5);
      }
    });

    it("N hits concorrentes: soma == N, sem lost update (prova de atomicidade)", async () => {
      // Repete p/ flushar o escalonamento (o interleaving nao e igual sempre).
      for (let iter = 0; iter < 25; iter += 1) {
        const key = freshKey();
        const N = 10;
        const results = await Promise.all(Array.from({ length: N }, () => store.hit(key, 60_000)));

        // Invariante DEFINITIVO (vale mesmo se a rajada cruzar a borda do minuto):
        // cada um dos N hits foi contado EXATAMENTE uma vez. Um read-modify-write
        // nao-atomico perderia updates -> soma < N (este assert fica VERMELHO).
        expect(await sumFor(key)).toBe(N);

        // No caso comum (janela unica) os retornos sao 1..N distintos e a linha
        // guarda N. So afirmamos isso quando nao houve straddle de borda (1 linha),
        // p/ nao dar falso-negativo raro; a soma acima ja e a prova principal.
        if ((await rowCount(key)) === 1) {
          expect([...results].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
          expect(new Set(results).size).toBe(N);
        }
      }
    });

    it("isolamento por key: contadores independentes", async () => {
      const a = freshKey();
      const b = freshKey();
      await store.hit(a, 60_000);
      await store.hit(a, 60_000);
      await store.hit(b, 60_000);
      expect(await sumFor(a)).toBe(2);
      expect(await sumFor(b)).toBe(1);
    });
  },
);

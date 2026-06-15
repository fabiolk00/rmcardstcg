// scripts/count-queries.ts
//
// Conta round-trips reais ao Postgres para detectar N+1.
// Voce usa @prisma/adapter-pg sobre node-postgres, entao a medida correta de N+1
// e contar no nivel do pg.Pool, nao no Prisma: e o numero de idas ao banco que
// explode num loop, independente de como o Prisma compila a query.
//
// Estrategia: instrumentar pool.query (e pool.connect -> client.query) e contar.
// Construa o PrismaPg adapter por cima desse pool instrumentado nos testes.

import { Pool, type PoolClient } from "pg";

export interface CountingPool {
  pool: Pool;
  getCount: () => number;
  reset: () => void;
  /** Roda fn e retorna quantas queries ela disparou (com reset antes). */
  measure: <T>(fn: () => Promise<T>) => Promise<{ result: T; queries: number }>;
}

// pg expoe query/connect como sobrecargas que nao casam com spread variadico;
// tratamos as referencias originais como callables genericos para instrumentar
// sem brigar com as overloads (e sem @ts-expect-error fragil).
type AnyFn = (...args: unknown[]) => unknown;

export function makeCountingPool(connectionString: string): CountingPool {
  const pool = new Pool({ connectionString });
  let count = 0;

  // Conta queries disparadas direto no pool.
  const origPoolQuery = pool.query.bind(pool) as AnyFn;
  (pool as unknown as { query: AnyFn }).query = (...args: unknown[]) => {
    count += 1;
    return origPoolQuery(...args);
  };

  // Conta queries disparadas em clients pegos via pool.connect() (transacoes).
  const origConnect = pool.connect.bind(pool) as AnyFn;
  (pool as unknown as { connect: AnyFn }).connect = (...args: unknown[]) => {
    const ret = origConnect(...args);
    // forma com Promise<PoolClient>
    if (ret && typeof (ret as Promise<PoolClient>).then === "function") {
      return (ret as Promise<PoolClient>).then((client) => {
        const origClientQuery = client.query.bind(client) as AnyFn;
        (client as unknown as { query: AnyFn }).query = (...a: unknown[]) => {
          count += 1;
          return origClientQuery(...a);
        };
        return client;
      });
    }
    return ret;
  };

  const getCount = () => count;
  const reset = () => {
    count = 0;
  };
  const measure = async <T>(fn: () => Promise<T>) => {
    reset();
    const result = await fn();
    return { result, queries: count };
  };

  return { pool, getCount, reset, measure };
}

export const N_PLUS_ONE_THRESHOLD = 15;

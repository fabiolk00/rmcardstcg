// Rate limiting plugavel.
//
// Default: janela deslizante EM MEMORIA (por instancia). Suficiente para dev e
// como mitigacao best-effort; em serverless multi-instancia o ideal e injetar um
// store COMPARTILHADO (Upstash/Vercel KV/Redis) via setRateLimitStore() no boot do
// servidor — a interface RateLimitStore foi feita para isso.

export interface RateLimitStore {
  /** Registra um hit em `key` e devolve quantos hits caem na janela atual. */
  hit(key: string, windowMs: number): Promise<number>;
}

/** Store em memoria (Map de timestamps por chave) com poda leve. */
export function createMemoryStore(): RateLimitStore {
  const buckets = new Map<string, number[]>();
  return {
    async hit(key, windowMs) {
      const now = Date.now();
      const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
      recent.push(now);
      buckets.set(key, recent);
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) {
          if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
        }
      }
      return recent.length;
    },
  };
}

let store: RateLimitStore = createMemoryStore();

/** Troca o store global (ex.: um adaptador de KV em producao). */
export function setRateLimitStore(s: RateLimitStore): void {
  store = s;
}

export type RateLimitResult = { allowed: boolean; count: number; limit: number };

/**
 * Registra um hit e diz se ainda esta dentro do limite (count <= limit) na janela.
 * `s` injetavel para testes; por padrao usa o store global.
 */
export async function checkRateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
  s: RateLimitStore = store,
): Promise<RateLimitResult> {
  const count = await s.hit(key, opts.windowMs);
  return { allowed: count <= opts.limit, count, limit: opts.limit };
}

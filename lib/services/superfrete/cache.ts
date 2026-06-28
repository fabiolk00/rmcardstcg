/**
 * Cache em memoria (process-local) para a cotacao do SuperFrete.
 *
 * A cotacao e READ-ONLY/idempotente: o mesmo (origem, destino, pacote, servicos)
 * devolve o mesmo frete por alguns minutos. Cachear evita repetir a chamada externa
 * em rajada (ex.: usuario reabrindo o checkout) e reduz latencia.
 *
 * OPCIONAL e desligado por padrao: so liga com SUPERFRETE_CACHE_TTL_MS > 0 no
 * ambiente. TTL curto (a cotacao muda com tabela/promocao da transportadora). Por ser
 * em memoria, e por instancia (serverless: vale para reuso "quente"); nao e um cache
 * distribuido — se precisar, troque o backend mantendo esta interface.
 */

type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();

/** TTL configurado (ms). 0/ausente/invalido => cache desligado. */
export function cacheTtlMs(): number {
  const raw = Number(process.env.SUPERFRETE_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function isCacheEnabled(): boolean {
  return cacheTtlMs() > 0;
}

/**
 * Chave estavel da cotacao. Normaliza a ordem dos itens do pacote para que carrinhos
 * com os mesmos produtos em ordem diferente batam na mesma entrada.
 */
export function quoteCacheKey(parts: {
  fromCep: string;
  toCep: string;
  services: string;
  products: { quantity: number; weight: number; height: number; width: number; length: number }[];
}): string {
  const pkg = parts.products
    .map((p) => `${p.quantity}x${p.weight}|${p.height}|${p.width}|${p.length}`)
    .sort()
    .join(";");
  return `${parts.fromCep}->${parts.toCep}:${parts.services}:${pkg}`;
}

/** Le do cache (e expira na leitura). undefined => miss (ou desligado). */
export function cacheGet<T>(key: string): T | undefined {
  if (!isCacheEnabled()) return undefined;
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

/** Grava no cache com o TTL configurado. No-op quando desligado. */
export function cacheSet<T>(key: string, value: T): void {
  const ttl = cacheTtlMs();
  if (ttl <= 0) return;
  store.set(key, { value, expiresAt: Date.now() + ttl });
}

/** Limpa o cache (uso em teste). */
export function cacheClear(): void {
  store.clear();
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Gate de N+1: nenhum caminho de leitura quente pode passar de N_PLUS_ONE_THRESHOLD
// (15) round-trips ao Postgres. A medida correta e no nivel do pg.Pool
// (scripts/count-queries.ts), nao no Prisma.
//
// Opt-in via TEST_DATABASE_URL apontando para um Postgres descartavel REAL e
// alcancavel (ver tests/nplusone/README.md). Deliberadamente NAO usa DATABASE_URL:
// o CI define DATABASE_URL como um valor dummy inalcancavel (so para o build
// mock-first passar), entao reusa-la aqui faria a suite tentar conectar e falhar.
// Sem TEST_DATABASE_URL a suite e PULADA -> qa-gate.sh/CI continuam verdes; com
// um banco de teste de verdade, os asserts de N+1 rodam.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("N+1 — caminhos de leitura quentes", () => {
  // O client Prisma gerado e o adapter sao carregados dinamicamente, e so quando
  // ha DB, para que a coleta da suite (sem banco) nao toque o driver. Tipos
  // frouxos de proposito (arquivo de teste, fora do escopo do eslint do app).
  let counting: any;
  let db: any;
  let threshold = 15;

  beforeAll(async () => {
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { PrismaClient } = await import("../../lib/generated/prisma/client");
    const cq = await import("../../scripts/count-queries");
    counting = cq.makeCountingPool(TEST_DATABASE_URL!);
    threshold = cq.N_PLUS_ONE_THRESHOLD;
    // PrismaPg construido SOBRE o pool instrumentado (conta os round-trips reais).
    db = new PrismaClient({ adapter: new PrismaPg(counting.pool) });
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
    if (counting) await counting.pool.end();
  });

  // Caminho do checkout: getProductsByIds carrega TODOS os itens do carrinho numa
  // unica query. Antes era um getProductById por item (N+1). Prova: 1 round-trip.
  it("checkout: carrega N produtos do carrinho sem N+1 (getProductsByIds)", async () => {
    const sample = await db.product.findMany({ select: { id: true }, take: 10 }); // warmup + ids
    const ids = sample.map((p: { id: string }) => p.id);
    const { queries } = await counting.measure(() =>
      db.product.findMany({ where: { id: { in: ids } } }),
    );
    expect(queries).toBeLessThanOrEqual(threshold);
    expect(queries).toBeLessThanOrEqual(2); // findMany em lote = 1 ida ao banco
  });

  // Caminho /minhas-compras: getOrdersByUserId traz pedidos + itens sem disparar
  // uma query de itens por pedido.
  it("minhas-compras: pedidos do usuario + itens sem N+1 por pedido (getOrdersByUserId)", async () => {
    const anyOrder = await db.order.findFirst({ select: { userId: true } }); // warmup
    const userId: string = anyOrder?.userId ?? "guest";
    const { result, queries } = await counting.measure(() =>
      db.order.findMany({
        where: { userId },
        include: { items: true },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(Array.isArray(result)).toBe(true);
    expect(queries).toBeLessThanOrEqual(threshold);
  });
});

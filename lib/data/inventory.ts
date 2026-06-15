import { Prisma } from "../generated/prisma/client";

/**
 * Reserva de estoque sem corrida (FUNDACAO, invariante 1) — dono unico do ciclo
 * reservar/estornar/baixar/repor. TODAS as funcoes recebem o `tx` da transacao
 * do chamador (checkout, webhook, cron); nunca o `prisma` global.
 *
 * Modelo: products.stock = estoque fisico; products.reserved = unidades
 * comprometidas por pedidos pendentes. Disponivel para venda = stock - reserved.
 * CHECK no DB garante 0 <= reserved <= stock.
 *
 * Ciclo de vida de um pedido:
 *   checkout            -> reserveStock  (reserved += qty)        + Order.stockReserved=true
 *   pagamento confirmado-> commitStock   (stock -=, reserved -=)  + Order.stockCommitted=true
 *   cancelar/expirar    -> releaseStock  (reserved -=)            + Order.stockReserved=false
 *   refund de pago      -> restockUnits  (stock +=)               + Order.stockCommitted=false
 *
 * As condicoes (stock - reserved >= qty etc.) sao comparacoes coluna-a-coluna,
 * que o updateMany do Prisma nao expressa — por isso $executeRaw parametrizado.
 */
export type StockItem = { productId: string; quantity: number };

/**
 * Reserva atomica e condicional. Para cada item: reserved += qty SE houver
 * disponibilidade (stock - reserved >= qty). Se algum item nao couber, devolve
 * { ok:false, productId } e o chamador DEVE abortar (rollback) a transacao.
 */
export async function reserveStock(
  tx: Prisma.TransactionClient,
  items: StockItem[],
): Promise<{ ok: true } | { ok: false; productId: string }> {
  for (const { productId, quantity } of items) {
    const affected = await tx.$executeRaw`
      UPDATE "products"
      SET "reserved" = "reserved" + ${quantity}
      WHERE "id" = ${productId}::uuid AND "stock" - "reserved" >= ${quantity}
    `;
    if (affected === 0) return { ok: false, productId };
  }
  return { ok: true };
}

/**
 * Estorno da reserva (cancelamento/expiracao). reserved -= qty. Idempotente em
 * conjunto com Order.stockReserved: so chamar quando stockReserved=true e flipar
 * para false na MESMA transacao.
 */
export async function releaseStock(
  tx: Prisma.TransactionClient,
  items: StockItem[],
): Promise<void> {
  for (const { productId, quantity } of items) {
    await tx.$executeRaw`
      UPDATE "products"
      SET "reserved" = "reserved" - ${quantity}
      WHERE "id" = ${productId}::uuid AND "reserved" >= ${quantity}
    `;
  }
}

/**
 * Baixa definitiva na confirmacao do pagamento: stock -= qty, reserved -= qty.
 * Idempotente via Order.stockCommitted (so executar quando false; flipar para
 * true na mesma transacao). Mantem o CHECK reserved <= stock.
 */
export async function commitStock(tx: Prisma.TransactionClient, items: StockItem[]): Promise<void> {
  for (const { productId, quantity } of items) {
    await tx.$executeRaw`
      UPDATE "products"
      SET "stock" = "stock" - ${quantity}, "reserved" = "reserved" - ${quantity}
      WHERE "id" = ${productId}::uuid AND "stock" >= ${quantity} AND "reserved" >= ${quantity}
    `;
  }
}

/**
 * Reposicao de estoque no refund/chargeback de um pedido JA PAGO (cujo estoque
 * ja foi baixado via commitStock). stock += qty, sem tocar em reserved.
 * Idempotente via Order.stockCommitted (so executar quando true; flipar para
 * false na mesma transacao).
 */
export async function restockUnits(
  tx: Prisma.TransactionClient,
  items: StockItem[],
): Promise<void> {
  for (const { productId, quantity } of items) {
    await tx.$executeRaw`
      UPDATE "products"
      SET "stock" = "stock" + ${quantity}
      WHERE "id" = ${productId}::uuid
    `;
  }
}

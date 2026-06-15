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
 * Agrega itens por productId somando quantity, preservando a ordem da primeira
 * ocorrencia. OBRIGATORIO antes de qualquer `UPDATE ... FROM (VALUES ...)`:
 * esse padrao atualiza cada linha-alvo UMA vez, entao o mesmo productId repetido
 * em `items` NAO somaria as duas quantidades (ao contrario do loop antigo, que
 * fazia um UPDATE por item). Aqui colapsamos para 1 linha por produto com a soma
 * correta — assim cada productId aparece uma unica vez no VALUES e o efeito bate
 * com o do loop sequencial. So agrega itens com quantity > 0 (qty <= 0 nao tem
 * efeito util e poluiria o VALUES).
 */
function aggregateByProduct(items: StockItem[]): { productId: string; quantity: number }[] {
  const totals = new Map<string, number>();
  for (const { productId, quantity } of items) {
    if (quantity <= 0) continue;
    totals.set(productId, (totals.get(productId) ?? 0) + quantity);
  }
  return Array.from(totals, ([productId, quantity]) => ({ productId, quantity }));
}

/**
 * Monta o fragmento `(id::uuid, qty::int), ...` para a clausula FROM (VALUES ...).
 * Tudo parametrizado (Prisma.join/Prisma.sql) — nunca interpolacao de string
 * crua. Os casts sao necessarios para o Postgres inferir o tipo das colunas de
 * `v(id, qty)` (id e UUID; qty e INTEGER) e casar no JOIN com "products".
 */
function valuesTuples(rows: { productId: string; quantity: number }[]): Prisma.Sql {
  return Prisma.join(rows.map((r) => Prisma.sql`(${r.productId}::uuid, ${r.quantity}::int)`));
}

/**
 * Reserva atomica e condicional, em LOTE (1 statement). Para cada produto:
 * reserved += qty SE houver disponibilidade (stock - reserved >= qty). O guard
 * vale por linha dentro do mesmo UPDATE; linhas que nao cabem simplesmente nao
 * sao atualizadas. Comparamos o conjunto retornado (RETURNING) com o solicitado:
 * se faltar algum, devolve { ok:false, productId } do PRIMEIRO produto que NAO
 * entrou (sempre um productId real do input) e o chamador DEVE abortar (rollback)
 * a transacao — o que descarta qualquer reserva parcial dos demais itens (todos
 * os call sites fazem throw/rollback ao receber ok:false).
 */
export async function reserveStock(
  tx: Prisma.TransactionClient,
  items: StockItem[],
): Promise<{ ok: true } | { ok: false; productId: string }> {
  const rows = aggregateByProduct(items);
  if (rows.length === 0) return { ok: true };

  const updated = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "products" AS p
    SET "reserved" = p."reserved" + v.qty
    FROM (VALUES ${valuesTuples(rows)}) AS v(id, qty)
    WHERE p."id" = v.id AND p."stock" - p."reserved" >= v.qty
    RETURNING p."id"
  `);

  if (updated.length === rows.length) return { ok: true };
  const reserved = new Set(updated.map((r) => r.id));
  const missing = rows.find((r) => !reserved.has(r.productId));
  // rows.length > updated.length garante que `missing` existe; fallback defensivo.
  return { ok: false, productId: missing?.productId ?? rows[0].productId };
}

/**
 * Estorno da reserva (cancelamento/expiracao), em LOTE. reserved -= qty.
 * Idempotente em conjunto com Order.stockReserved: so chamar quando
 * stockReserved=true e flipar para false na MESMA transacao.
 */
export async function releaseStock(
  tx: Prisma.TransactionClient,
  items: StockItem[],
): Promise<void> {
  const rows = aggregateByProduct(items);
  if (rows.length === 0) return;

  await tx.$executeRaw(Prisma.sql`
    UPDATE "products" AS p
    SET "reserved" = p."reserved" - v.qty
    FROM (VALUES ${valuesTuples(rows)}) AS v(id, qty)
    WHERE p."id" = v.id AND p."reserved" >= v.qty
  `);
}

/**
 * Baixa definitiva na confirmacao do pagamento, em LOTE: stock -= qty,
 * reserved -= qty. Idempotente via Order.stockCommitted (so executar quando
 * false; flipar para true na mesma transacao). Mantem o CHECK reserved <= stock.
 */
export async function commitStock(tx: Prisma.TransactionClient, items: StockItem[]): Promise<void> {
  const rows = aggregateByProduct(items);
  if (rows.length === 0) return;

  await tx.$executeRaw(Prisma.sql`
    UPDATE "products" AS p
    SET "stock" = p."stock" - v.qty, "reserved" = p."reserved" - v.qty
    FROM (VALUES ${valuesTuples(rows)}) AS v(id, qty)
    WHERE p."id" = v.id AND p."stock" >= v.qty AND p."reserved" >= v.qty
  `);
}

/**
 * Reposicao de estoque no refund/chargeback de um pedido JA PAGO (cujo estoque
 * ja foi baixado via commitStock), em LOTE. stock += qty, sem tocar em reserved.
 * Idempotente via Order.stockCommitted (so executar quando true; flipar para
 * false na mesma transacao).
 */
export async function restockUnits(
  tx: Prisma.TransactionClient,
  items: StockItem[],
): Promise<void> {
  const rows = aggregateByProduct(items);
  if (rows.length === 0) return;

  await tx.$executeRaw(Prisma.sql`
    UPDATE "products" AS p
    SET "stock" = p."stock" + v.qty
    FROM (VALUES ${valuesTuples(rows)}) AS v(id, qty)
    WHERE p."id" = v.id
  `);
}

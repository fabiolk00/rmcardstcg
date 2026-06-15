import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import type { OrderItemModel, OrderModel } from "../generated/prisma/models";
import { type AuditActor, writeAuditLog } from "./audit";
import { commitStock, releaseStock, reserveStock, restockUnits } from "./inventory";
import { SHIPPING_TRANSITIONS } from "./orderTransitions";
import type { Order, OrderAddress, OrderItem, PaymentStatus, ShippingStatus } from "./types";

/**
 * Camada de dados de pedidos — Postgres via Prisma (lib/db).
 *
 * Fronteira DB <-> dominio (Order, lib/data/types.ts):
 * - id (Int sequencial) -> "#" + id; createdAt (Date) -> ISO string;
 * - colunas address_* achatadas -> objeto address aninhado;
 * - itens (relacao) -> OrderItem[] do contrato.
 */
type OrderRow = OrderModel & { items: OrderItemModel[] };

const withItems = { items: true } as const;

function toOrder(row: OrderRow): Order {
  return {
    id: `#${row.id}`,
    userId: row.userId,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    address: {
      cep: row.addressCep,
      street: row.addressStreet,
      city: row.addressCity,
      state: row.addressState,
    },
    items: row.items.map((it) => ({
      productId: it.productId,
      productName: it.productName,
      quantity: it.quantity,
      unitPriceCents: it.unitPriceCents,
    })),
    subtotalCents: row.subtotalCents,
    discountCents: row.discountCents,
    couponCode: row.couponCode,
    couponDiscountCents: row.couponDiscountCents,
    shippingCents: row.shippingCents,
    totalCents: row.totalCents,
    shippingService: row.shippingService,
    shippingDays: row.shippingDays,
    paymentStatus: row.paymentStatus as PaymentStatus,
    paymentMethod: row.paymentMethod,
    shippingStatus: row.shippingStatus as ShippingStatus,
    internalNote: row.internalNote,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Todos os pedidos (admin), mais recentes primeiro. */
export async function getOrders(): Promise<Order[]> {
  const rows = await prisma.order.findMany({
    include: withItems,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toOrder);
}

/** Pedido por id legivel (ex.: "#10421"); null se nao existir. */
export async function getOrderById(id: string): Promise<Order | null> {
  const numericId = Number(id.replace(/^#/, ""));
  if (!Number.isInteger(numericId)) return null;
  const row = await prisma.order.findUnique({
    where: { id: numericId },
    include: withItems,
  });
  return row ? toOrder(row) : null;
}

/** Pedidos de um usuario (Minhas Compras), mais recentes primeiro. */
export async function getOrdersByUserId(userId: string): Promise<Order[]> {
  const rows = await prisma.order.findMany({
    where: { userId },
    include: withItems,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toOrder);
}

/** Dados para criar um pedido (checkout). Totais/snapshots calculados no servidor. */
export type CreateOrderInput = {
  /** Idempotencia de checkout (invariante 2): chave estavel por tentativa. */
  checkoutKey: string;
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  address: OrderAddress;
  items: OrderItem[];
  subtotalCents: number;
  discountCents: number;
  /** Cupom aplicado (codigo + abatimento), recalculado no server. */
  couponCode?: string | null;
  couponDiscountCents?: number;
  shippingCents: number;
  totalCents: number;
  paymentMethod: string;
  shippingService?: string | null;
  shippingDays?: string | null;
  /** Vencimento do PIX (fonte unica p/ o pg_cron); derivado de PIX_DUE_DAYS. */
  dueDate?: Date | null;
};

/** Resultado da criacao: pedido novo, reaproveitado (idempotencia) ou sem estoque. */
export type CreateOrderResult =
  | { ok: true; reused: boolean; order: Order }
  | { ok: false; reason: "out_of_stock"; productId: string };

/** Sinaliza rollback por indisponibilidade de estoque (uso interno na transacao). */
export class OutOfStockError extends Error {
  constructor(public readonly productId: string) {
    super(`sem estoque: ${productId}`);
    this.name = "OutOfStockError";
  }
}

/** Detecta violacao de unique do Prisma (P2002), opcionalmente num campo/alvo. */
function isUniqueViolation(err: unknown, target?: string): boolean {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e?.code !== "P2002") return false;
  if (!target) return true;
  const t = e.meta?.target;
  return Array.isArray(t)
    ? t.some((x) => String(x).includes(target))
    : String(t ?? "").includes(target);
}

/** Falha de serializacao/deadlock (P2034) — seguro para retry da transacao. */
function isSerializationFailure(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2034";
}

/** Pedido por checkoutKey (idempotencia); null se ainda nao existir. */
export async function findOrderByCheckoutKey(checkoutKey: string): Promise<Order | null> {
  const row = await prisma.order.findUnique({ where: { checkoutKey }, include: withItems });
  return row ? toOrder(row) : null;
}

/** Refs Asaas ja gravados (para reusar a MESMA cobranca no retry de checkout). */
export async function getOrderAsaasRefs(
  orderId: number,
): Promise<{ paymentId: string | null; customerId: string | null } | null> {
  const row = await prisma.order.findUnique({
    where: { id: orderId },
    select: { asaasPaymentId: true, asaasCustomerId: true },
  });
  if (!row) return null;
  return { paymentId: row.asaasPaymentId, customerId: row.asaasCustomerId };
}

/**
 * Cria o pedido (pending) + itens E reserva o estoque na MESMA transacao
 * (invariante 1). A reserva e atomica e condicional (reserveStock); se faltar
 * estoque a transacao faz rollback (nada e gravado) e retornamos out_of_stock.
 *
 * Idempotencia (invariante 2): checkoutKey e UNIQUE. Curto-circuito barato antes
 * da transacao; em corrida (duplo-clique), quem perde o INSERT viola a unique
 * (P2002) e tratamos como "reaproveitar" — nunca cria pedido/cobranca dupla.
 *
 * `redeem` (opcional): efeito adicional rodado DENTRO da mesma transacao depois
 * de criar o pedido (ex.: redencao de cupom). Se lancar, a transacao inteira faz
 * rollback (inclusive a reserva de estoque) e o erro propaga ao chamador.
 */
export async function createOrderWithReservation(
  input: CreateOrderInput,
  redeem?: (tx: Prisma.TransactionClient, orderId: number) => Promise<void>,
): Promise<CreateOrderResult> {
  const existing = await findOrderByCheckoutKey(input.checkoutKey);
  if (existing) return { ok: true, reused: true, order: existing };

  // Com redencao de cupom, isolamos em Serializable + retry para fechar a corrida
  // do limite por usuario (Q7); sem cupom, READ COMMITTED + colapso por checkoutKey.
  const txOptions = redeem
    ? { timeout: 15000, maxWait: 5000, isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    : { timeout: 15000, maxWait: 5000 };
  const maxAttempts = redeem ? 3 : 1;

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await prisma.$transaction(async (tx) => {
        const reserve = await reserveStock(
          tx,
          input.items.map((it) => ({ productId: it.productId, quantity: it.quantity })),
        );
        if (!reserve.ok) throw new OutOfStockError(reserve.productId);

        const row = await tx.order.create({
          data: {
            checkoutKey: input.checkoutKey,
            userId: input.userId,
            customerName: input.customerName,
            customerEmail: input.customerEmail,
            customerPhone: input.customerPhone,
            addressCep: input.address.cep,
            addressStreet: input.address.street,
            addressCity: input.address.city,
            addressState: input.address.state,
            subtotalCents: input.subtotalCents,
            discountCents: input.discountCents,
            couponCode: input.couponCode ?? null,
            couponDiscountCents: input.couponDiscountCents ?? 0,
            shippingCents: input.shippingCents,
            totalCents: input.totalCents,
            paymentMethod: input.paymentMethod,
            shippingService: input.shippingService ?? null,
            shippingDays: input.shippingDays ?? null,
            dueDate: input.dueDate ?? null,
            stockReserved: true,
            items: {
              create: input.items.map((it) => ({
                productId: it.productId,
                productName: it.productName,
                quantity: it.quantity,
                unitPriceCents: it.unitPriceCents,
              })),
            },
          },
          include: withItems,
        });

        if (redeem) await redeem(tx, row.id);

        return { ok: true as const, reused: false, order: toOrder(row) };
      }, txOptions);
    } catch (err) {
      if (err instanceof OutOfStockError) {
        return { ok: false, reason: "out_of_stock", productId: err.productId };
      }
      // Corrida de checkoutKey: outra tentativa criou o pedido entre o find e o create.
      if (isUniqueViolation(err, "checkout_key")) {
        const winner = await findOrderByCheckoutKey(input.checkoutKey);
        if (winner) return { ok: true, reused: true, order: winner };
        throw err;
      }
      // Conflito de serializacao: retry a transacao inteira (nada foi commitado).
      if (isSerializationFailure(err) && attempt < maxAttempts) continue;
      throw err;
    }
  }
  // Inalcançavel (o loop sempre retorna ou lança); guarda para o type-checker.
  throw new Error("createOrderWithReservation: tentativas de serialização esgotadas.");
}

/**
 * Grava no pedido a cobranca/cliente do Asaas (chamado no checkout, apos criar a
 * cobranca). Esses refs sao o elo que o webhook usa para verificar o evento.
 */
export async function setOrderAsaasRefs(
  orderId: number,
  refs: { paymentId: string; customerId: string },
): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: { asaasPaymentId: refs.paymentId, asaasCustomerId: refs.customerId },
  });
}

/** Dados da cobranca vindos do evento do webhook, para verificar antes de aplicar. */
export type PaymentRef = { id: string; valueCents: number | null };

/** Resultado da atualizacao de status — distingue nao-encontrado, rejeitado e reenvio. */
export type PaymentStatusUpdate =
  | { found: false }
  | { found: true; ok: false; reason: "payment_mismatch" | "value_mismatch" }
  | {
      found: true;
      ok: true;
      changed: boolean;
      previousStatus: PaymentStatus;
      status: PaymentStatus;
    };

/**
 * Atualiza o status de pagamento de um pedido (usado pelo webhook do Asaas).
 *
 * Verificacao (anti-replay/anti-fraude): a cobranca do evento tem que ser a deste
 * pedido (payment.id == asaasPaymentId) — isso barra injetar o externalReference
 * de outro pedido — e o valor tem que bater com o total. So entao aplica.
 *
 * Idempotencia: le o status atual e so escreve quando muda. Reenviar o mesmo
 * evento (o Asaas reenfileira ate receber 2xx) nao reescreve nem dispara efeito;
 * o retorno informa se houve mudanca real ou se foi um reprocessamento.
 */
/**
 * Nucleo transacional da atualizacao de status de pagamento (usado pelo webhook).
 * Recebe o `tx` EXTERNO para que o ledger de webhook (recordWebhookEvent +
 * markWebhookEventProcessed) e o efeito rodem na MESMA transacao — fechando o gap
 * "registrado mas nao aplicado" se algo falhar (at-least-once correto).
 *
 * Verificacao (anti-replay/anti-fraude): payment.id == asaasPaymentId e, SOMENTE
 * quando status='paid', valor dentro de +-1 centavo (um cancelamento/refund nao
 * precisa bater valor). CAS idempotente: so escreve se o status ainda for o lido.
 *
 * Conciliacao de estoque atomica e idempotente (flags no pedido):
 *  - 'paid':      commitStock  (baixa de stock)        — guard stockReserved && !stockCommitted.
 *  - 'cancelled': releaseStock (estorna reserva)        — guard stockReserved && !stockCommitted;
 *                 OU restockUnits (repoe estoque ja baixado) — guard stockCommitted (refund de pago).
 */
export async function applyPaymentStatusTx(
  tx: Prisma.TransactionClient,
  orderId: number,
  status: PaymentStatus,
  payment: PaymentRef,
): Promise<PaymentStatusUpdate> {
  const existing = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      paymentStatus: true,
      asaasPaymentId: true,
      totalCents: true,
      stockReserved: true,
      stockCommitted: true,
      items: { select: { productId: true, quantity: true } },
    },
  });
  if (!existing) return { found: false };

  if (!existing.asaasPaymentId) {
    console.error(`[orders] pedido #${orderId} sem asaasPaymentId ao receber evento de pagamento.`);
    return { found: true, ok: false, reason: "payment_mismatch" };
  }
  if (existing.asaasPaymentId !== payment.id) {
    return { found: true, ok: false, reason: "payment_mismatch" };
  }
  // Valor so e verificado na confirmacao do pagamento; cancelamento/refund nao
  // carrega necessariamente o mesmo valor (e nao deve ser barrado por isso).
  if (
    status === "paid" &&
    payment.valueCents !== null &&
    Math.abs(payment.valueCents - existing.totalCents) > 1
  ) {
    return { found: true, ok: false, reason: "value_mismatch" };
  }

  const previousStatus = existing.paymentStatus as PaymentStatus;

  // Conciliacao de estoque idempotente (guardada por flags), independente do CAS.
  await reconcileStockForPaymentStatus(tx, orderId, status, existing);

  if (previousStatus === status) {
    return { found: true, ok: true, changed: false, previousStatus, status };
  }

  // Compare-and-swap: so escreve se o status ainda for o que lemos.
  const res = await tx.order.updateMany({
    where: { id: orderId, paymentStatus: previousStatus },
    data: { paymentStatus: status },
  });
  return { found: true, ok: true, changed: res.count > 0, previousStatus, status };
}

/**
 * Wrapper transacional de applyPaymentStatusTx para chamadores que nao tem um
 * `tx` proprio (ex.: reconciliacao). O webhook usa applyPaymentStatusTx direto,
 * dentro da transacao do ledger de eventos.
 */
export async function setOrderPaymentStatus(
  orderId: number,
  status: PaymentStatus,
  payment: PaymentRef,
): Promise<PaymentStatusUpdate> {
  return prisma.$transaction((tx) => applyPaymentStatusTx(tx, orderId, status, payment), {
    timeout: 15000,
    maxWait: 5000,
  });
}

// ===========================================================================
// Conciliacao de estoque por status de pagamento (compartilhada entre o webhook
// e o ajuste manual do admin). Idempotente via flags stockReserved/stockCommitted.
// ===========================================================================
type StockSnapshot = {
  stockReserved: boolean;
  stockCommitted: boolean;
  items: { productId: string; quantity: number }[];
};

async function reconcileStockForPaymentStatus(
  tx: Prisma.TransactionClient,
  orderId: number,
  status: PaymentStatus,
  snap: StockSnapshot,
): Promise<void> {
  const lines = snap.items.map((it) => ({ productId: it.productId, quantity: it.quantity }));
  if (status === "paid" && snap.stockReserved && !snap.stockCommitted) {
    await commitStock(tx, lines);
    await tx.order.update({
      where: { id: orderId },
      data: { stockCommitted: true, stockReserved: false },
    });
  } else if (status === "cancelled") {
    if (snap.stockReserved && !snap.stockCommitted) {
      await releaseStock(tx, lines);
      await tx.order.update({ where: { id: orderId }, data: { stockReserved: false } });
    } else if (snap.stockCommitted) {
      // Refund/chargeback de pedido JA PAGO: repoe o estoque baixado (Q3).
      await restockUnits(tx, lines);
      await tx.order.update({ where: { id: orderId }, data: { stockCommitted: false } });
    }
  }
}

// ===========================================================================
// Mutacoes de pedido pelo ADMIN — transacionais e auditadas (invariante 3).
// O AuditActor e resolvido no server ANTES de abrir a transacao (invariante 4).
// ===========================================================================

/** Snapshot enxuto do pedido p/ before/after do audit_log. */
function orderAuditSnapshot(row: {
  paymentStatus: PaymentStatus | string;
  shippingStatus: ShippingStatus | string;
  internalNote: string | null;
}): Prisma.InputJsonValue {
  return {
    paymentStatus: row.paymentStatus as PaymentStatus,
    shippingStatus: row.shippingStatus as ShippingStatus,
    internalNote: row.internalNote ?? null,
  };
}

/** Resultado dos writes de admin: nao-encontrado / transicao invalida / no-op / aplicado. */
export type AdminOrderUpdate =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_transition"; from: ShippingStatus; to: ShippingStatus }
  | { ok: true; changed: boolean; order: Order };

/** Select padrao p/ os writes de admin: estado + flags/itens p/ conciliar estoque. */
const adminOrderSelect = {
  paymentStatus: true,
  shippingStatus: true,
  internalNote: true,
  stockReserved: true,
  stockCommitted: true,
  items: { select: { productId: true, quantity: true } },
} as const;

async function reloadOrder(tx: Prisma.TransactionClient, orderId: number): Promise<Order> {
  const row = await tx.order.findUnique({ where: { id: orderId }, include: withItems });
  return toOrder(row as OrderRow);
}

/**
 * Atualiza o status de ENVIO de um pedido (admin). Valida a transicao contra a
 * maquina de estados (SHIPPING_TRANSITIONS), aplica via compare-and-swap atomico
 * e grava audit_log na MESMA transacao. Ao CANCELAR, concilia o estoque (libera a
 * reserva ou repoe o estoque ja baixado) — idempotente via flags. Idempotente:
 * pedir o estado atual = no-op.
 */
export async function updateOrderShippingStatus(
  orderId: number,
  to: ShippingStatus,
  actor: AuditActor,
  ctx?: { requestId?: string | null; ip?: string | null },
): Promise<AdminOrderUpdate> {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.order.findUnique({ where: { id: orderId }, select: adminOrderSelect });
      if (!existing) return { ok: false, reason: "not_found" } as const;

      const from = existing.shippingStatus as ShippingStatus;
      if (from === to) {
        return { ok: true, changed: false, order: await reloadOrder(tx, orderId) } as const;
      }
      if (!SHIPPING_TRANSITIONS[from].includes(to)) {
        return { ok: false, reason: "invalid_transition", from, to } as const;
      }

      const res = await tx.order.updateMany({
        where: { id: orderId, shippingStatus: from },
        data: { shippingStatus: to },
      });
      if (res.count === 0) {
        return { ok: true, changed: false, order: await reloadOrder(tx, orderId) } as const;
      }

      // Cancelar envio libera/repoe estoque (alinhado ao refund do webhook).
      if (to === "cancelled") {
        await reconcileStockForPaymentStatus(tx, orderId, "cancelled", existing);
      }

      await writeAuditLog(tx, {
        actor,
        action: AuditAction.order_shipping_status_update,
        entityType: AuditEntityType.order,
        entityId: String(orderId),
        before: orderAuditSnapshot(existing),
        after: orderAuditSnapshot({ ...existing, shippingStatus: to }),
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
      });

      return { ok: true, changed: true, order: await reloadOrder(tx, orderId) } as const;
    },
    { timeout: 15000, maxWait: 5000 },
  );
}

/**
 * Atualiza a NOTA INTERNA do pedido (admin). Grava audit_log na mesma transacao.
 * Normaliza string vazia -> null. Idempotente: nota igual = no-op (sem audit).
 */
export async function updateOrderInternalNote(
  orderId: number,
  note: string | null,
  actor: AuditActor,
  ctx?: { requestId?: string | null; ip?: string | null },
): Promise<AdminOrderUpdate> {
  const normalized = note && note.trim().length > 0 ? note.trim() : null;
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.order.findUnique({ where: { id: orderId }, select: adminOrderSelect });
      if (!existing) return { ok: false, reason: "not_found" } as const;

      if ((existing.internalNote ?? null) === normalized) {
        return { ok: true, changed: false, order: await reloadOrder(tx, orderId) } as const;
      }

      await tx.order.update({ where: { id: orderId }, data: { internalNote: normalized } });

      await writeAuditLog(tx, {
        actor,
        action: AuditAction.order_note_update,
        entityType: AuditEntityType.order,
        entityId: String(orderId),
        before: orderAuditSnapshot(existing),
        after: orderAuditSnapshot({ ...existing, internalNote: normalized }),
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
      });

      return { ok: true, changed: true, order: await reloadOrder(tx, orderId) } as const;
    },
    { timeout: 15000, maxWait: 5000 },
  );
}

/**
 * AJUSTE MANUAL do status de pagamento pelo admin — SEGREGADO do webhook. NAO faz
 * verificacao de cobranca Asaas; e intervencao humana e por isso SEMPRE deixa
 * trilha: exige `reason`, registrado no audit_log (after.adjustmentReason).
 * Concilia estoque conforme o destino (paid -> commit; cancelled -> release/restock),
 * idempotente via flags. Aplicado via compare-and-swap + audit na mesma transacao.
 */
export async function adjustOrderPaymentStatus(
  orderId: number,
  to: PaymentStatus,
  reason: string,
  actor: AuditActor,
  ctx?: { requestId?: string | null; ip?: string | null },
): Promise<AdminOrderUpdate> {
  const trimmedReason = reason.trim();
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.order.findUnique({ where: { id: orderId }, select: adminOrderSelect });
      if (!existing) return { ok: false, reason: "not_found" } as const;

      const from = existing.paymentStatus as PaymentStatus;
      if (from === to) {
        return { ok: true, changed: false, order: await reloadOrder(tx, orderId) } as const;
      }

      const res = await tx.order.updateMany({
        where: { id: orderId, paymentStatus: from },
        data: { paymentStatus: to },
      });
      if (res.count === 0) {
        return { ok: true, changed: false, order: await reloadOrder(tx, orderId) } as const;
      }

      await reconcileStockForPaymentStatus(tx, orderId, to, existing);

      await writeAuditLog(tx, {
        actor,
        action: AuditAction.order_payment_status_update,
        entityType: AuditEntityType.order,
        entityId: String(orderId),
        before: orderAuditSnapshot(existing),
        after: {
          ...(orderAuditSnapshot({ ...existing, paymentStatus: to }) as Record<string, unknown>),
          manualAdjustment: true,
          adjustmentReason: trimmedReason,
        } as Prisma.InputJsonValue,
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
      });

      return { ok: true, changed: true, order: await reloadOrder(tx, orderId) } as const;
    },
    { timeout: 15000, maxWait: 5000 },
  );
}

/**
 * Cancela um pedido e estorna a reserva de estoque — usado FORA do webhook (job
 * pg_cron de expiracao de pendentes vencidos). Idempotente: so estorna quando
 * stockReserved=true e nao houve commit; marca paymentStatus=cancelled. Nao grava
 * audit_log (fluxo de sistema, nao mutacao de admin).
 */
export async function cancelOrderAndReleaseStock(orderId: number): Promise<{ released: boolean }> {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          stockReserved: true,
          stockCommitted: true,
          items: { select: { productId: true, quantity: true } },
        },
      });
      if (!existing) return { released: false };

      if (existing.stockReserved && !existing.stockCommitted) {
        await releaseStock(
          tx,
          existing.items.map((it) => ({ productId: it.productId, quantity: it.quantity })),
        );
        await tx.order.update({
          where: { id: orderId },
          data: { stockReserved: false, paymentStatus: "cancelled" },
        });
        return { released: true };
      }
      await tx.order.updateMany({
        where: { id: orderId, paymentStatus: "pending" },
        data: { paymentStatus: "cancelled" },
      });
      return { released: false };
    },
    { timeout: 15000, maxWait: 5000 },
  );
}

import { prisma } from "../db";
import type { OrderItemModel, OrderModel } from "../generated/prisma/models";
import type { Order, PaymentStatus, ShippingStatus } from "./types";

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

/**
 * Atualiza o status de pagamento de um pedido (usado pelo webhook do Asaas).
 * Usa updateMany para nao lancar quando o id nao existe — retorna se afetou algo.
 */
export async function setOrderPaymentStatus(
  orderId: number,
  status: PaymentStatus,
): Promise<boolean> {
  const result = await prisma.order.updateMany({
    where: { id: orderId },
    data: { paymentStatus: status },
  });
  return result.count > 0;
}

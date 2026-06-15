import { prisma } from "../db";
import type { OrderItemModel, OrderModel } from "../generated/prisma/models";
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
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  address: OrderAddress;
  items: OrderItem[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  totalCents: number;
  paymentMethod: string;
  shippingService?: string | null;
  shippingDays?: string | null;
};

/**
 * Cria um pedido (status de pagamento "pending") com seus itens, em uma unica
 * transacao (o Prisma aninha o create dos itens). Retorna o pedido ja no formato
 * do dominio — o id sequencial vira o externalReference da cobranca no Asaas.
 */
export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const row = await prisma.order.create({
    data: {
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
      shippingCents: input.shippingCents,
      totalCents: input.totalCents,
      paymentMethod: input.paymentMethod,
      shippingService: input.shippingService ?? null,
      shippingDays: input.shippingDays ?? null,
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
  return toOrder(row);
}

/** Resultado da atualizacao de status — distingue nao-encontrado de reenvio. */
export type PaymentStatusUpdate =
  | { found: false }
  | { found: true; changed: boolean; previousStatus: PaymentStatus; status: PaymentStatus };

/**
 * Atualiza o status de pagamento de um pedido (usado pelo webhook do Asaas).
 *
 * Idempotencia: le o status atual e so escreve quando muda. Reenviar o mesmo
 * evento (o Asaas reenfileira ate receber 2xx) nao reescreve nem dispara efeito;
 * o retorno informa se houve mudanca real ou se foi um reprocessamento.
 *
 * Limitacao conhecida (exige migration): sem guardar asaas_payment_id/valor nao
 * da pra dedupar por evento nem verificar o pagamento real. Ver handoff do F14.
 */
export async function setOrderPaymentStatus(
  orderId: number,
  status: PaymentStatus,
): Promise<PaymentStatusUpdate> {
  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    select: { paymentStatus: true },
  });
  if (!existing) return { found: false };

  const previousStatus = existing.paymentStatus as PaymentStatus;
  if (previousStatus === status) {
    return { found: true, changed: false, previousStatus, status };
  }

  await prisma.order.update({
    where: { id: orderId },
    data: { paymentStatus: status },
  });
  return { found: true, changed: true, previousStatus, status };
}

import { prisma } from "../db";
import type { LabelStore, LabelStoreEntry } from "@/lib/services/superfrete/labels";

/**
 * Store de idempotencia da etiqueta EM BANCO (tabela shipping_labels).
 *
 * O default do modulo de etiqueta e em memoria: sobrevive a um retry no mesmo
 * processo, mas nao a um deploy nem ao segundo lambda. Como emitir etiqueta
 * PAGA (debita a carteira SuperFrete), perder o registro entre a criacao do
 * carrinho e a confirmacao significaria pagar duas vezes pelo mesmo envio.
 *
 * Chave: externalRef "pedido-<id>" — estavel e derivavel do pedido, entao a
 * linha e localizavel dos dois lados (pelo pedido e pela referencia).
 */
export const LABEL_REF_PREFIX = "pedido-";

export function labelRefForOrder(orderId: number): string {
  return `${LABEL_REF_PREFIX}${orderId}`;
}

/** Id do pedido a partir da referencia; null se a forma nao bater. */
export function orderIdFromLabelRef(ref: string): number | null {
  if (!ref.startsWith(LABEL_REF_PREFIX)) return null;
  const id = Number(ref.slice(LABEL_REF_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Status do provedor que significam "esta etiqueta nao vale mais". */
const DEAD_STATUSES = ["canceled", "cancelled"];

export const prismaLabelStore: LabelStore = {
  /**
   * Devolve a etiqueta viva desta referencia. CANCELADA conta como inexistente:
   * o admin que cancelou e emitiu de novo precisa de um envio NOVO no provedor,
   * nao a retomada do que foi estornado.
   */
  async get(ref: string): Promise<LabelStoreEntry | null> {
    const row = await prisma.shippingLabel.findUnique({ where: { externalRef: ref } });
    if (!row || DEAD_STATUSES.includes(row.status)) return null;
    return { superFreteId: row.superFreteId, paid: row.paid };
  },

  /**
   * Grava o vinculo referencia -> envio. Upsert: a MESMA linha acompanha o
   * pedido do carrinho (paid=false) ate o pagamento (paid=true), e e reusada se
   * a etiqueta for cancelada e reemitida.
   */
  async set(ref: string, entry: LabelStoreEntry): Promise<void> {
    const orderId = orderIdFromLabelRef(ref);
    if (orderId === null) {
      // Referencia fora do padrao do dominio (so aconteceria por chamada
      // programatica): nao ha pedido para vincular, entao nao persiste.
      console.warn("[shipping-label] referencia sem pedido, store ignorado:", ref);
      return;
    }
    await prisma.shippingLabel.upsert({
      where: { externalRef: ref },
      create: {
        orderId,
        externalRef: ref,
        superFreteId: entry.superFreteId,
        status: entry.paid ? "released" : "pending",
        paid: entry.paid,
      },
      update: {
        superFreteId: entry.superFreteId,
        paid: entry.paid,
        // Reemissao depois de um cancelamento reabre a linha.
        ...(entry.paid ? { status: "released" } : { status: "pending" }),
      },
    });
  },
};

/** Estado final da etiqueta apos a emissao (o que o admin ve no pedido). */
export type PersistLabelInput = {
  orderId: number;
  superFreteId: string;
  status: string;
  paid: boolean;
  costCents: number;
  trackingCode?: string | null;
  labelUrl?: string | null;
};

/** Persiste o resultado da emissao (idempotente por pedido). */
export async function persistLabel(input: PersistLabelInput): Promise<void> {
  const externalRef = labelRefForOrder(input.orderId);
  await prisma.shippingLabel.upsert({
    where: { externalRef },
    create: {
      orderId: input.orderId,
      externalRef,
      superFreteId: input.superFreteId,
      status: input.status,
      paid: input.paid,
      costCents: input.costCents,
      trackingCode: input.trackingCode ?? null,
      labelUrl: input.labelUrl ?? null,
    },
    update: {
      superFreteId: input.superFreteId,
      status: input.status,
      paid: input.paid,
      costCents: input.costCents,
      ...(input.trackingCode !== undefined ? { trackingCode: input.trackingCode } : {}),
      ...(input.labelUrl !== undefined ? { labelUrl: input.labelUrl } : {}),
    },
  });
}

/** Guarda a URL de impressao devolvida pelo provedor (evita re-pedir a cada clique). */
export async function saveLabelUrl(orderId: number, labelUrl: string): Promise<void> {
  await prisma.shippingLabel
    .update({ where: { orderId }, data: { labelUrl } })
    .catch(() => undefined);
}

/** Marca a etiqueta como cancelada (o store passa a tratar como inexistente). */
export async function markLabelCanceled(orderId: number): Promise<void> {
  await prisma.shippingLabel
    .update({ where: { orderId }, data: { status: "canceled", paid: false, labelUrl: null } })
    .catch(() => undefined);
}

/** Etiqueta do pedido, ou null. */
export async function getOrderLabel(orderId: number) {
  return prisma.shippingLabel.findUnique({ where: { orderId } });
}

import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import type { OrderItemModel, OrderModel, ShippingLabelModel } from "../generated/prisma/models";
import { type AuditActor, writeAuditLog } from "./audit";
import { isCarrierId } from "./carriers";
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
type OrderRow = OrderModel & { items: OrderItemModel[]; shippingLabel?: ShippingLabelModel | null };

const withItems = { items: true, shippingLabel: true } as const;

function toOrder(row: OrderRow): Order {
  return {
    id: `#${row.id}`,
    userId: row.userId,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    customerPhone: row.customerPhone,
    customerDocument: row.customerDocument,
    address: {
      cep: row.addressCep,
      street: row.addressStreet,
      number: row.addressNumber,
      complement: row.addressComplement,
      district: row.addressDistrict,
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
    shippingServiceCode: row.shippingServiceCode,
    shippingDays: row.shippingDays,
    paymentStatus: row.paymentStatus as PaymentStatus,
    paymentMethod: row.paymentMethod,
    shippingStatus: row.shippingStatus as ShippingStatus,
    trackingCode: row.trackingCode,
    shippingCarrier: row.shippingCarrier,
    internalNote: row.internalNote,
    shippingLabel: row.shippingLabel
      ? {
          superFreteId: row.shippingLabel.superFreteId,
          status: row.shippingLabel.status,
          paid: row.shippingLabel.paid,
          costCents: row.shippingLabel.costCents,
          labelUrl: row.shippingLabel.labelUrl,
          trackingCode: row.shippingLabel.trackingCode,
        }
      : null,
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
 * Pedido por id legivel SOMENTE se pertencer ao usuario (guard de IDOR centralizado
 * — a tela de detalhe nunca deve revelar pedido de outro cliente). Retorna null
 * quando nao existe OU nao e do dono; o chamador trata os dois como 404 (nao
 * distinguir "existe mas nao e seu" de "nao existe" evita enumeracao de pedidos).
 */
export async function getOrderForUser(id: string, userId: string): Promise<Order | null> {
  const order = await getOrderById(id);
  if (!order || order.userId !== userId) return null;
  return order;
}

/** Dados para criar um pedido (checkout). Totais/snapshots calculados no servidor. */
export type CreateOrderInput = {
  /** Idempotencia de checkout (invariante 2): chave estavel por tentativa. */
  checkoutKey: string;
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** CPF/CNPJ (so digitos) — snapshot para a etiqueta. */
  customerDocument?: string | null;
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
  /** Codigo numerico da modalidade cotada (necessario para emitir a etiqueta). */
  shippingServiceCode?: number | null;
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

/**
 * Detecta violacao de unique do Prisma (P2002), opcionalmente num campo/alvo.
 *
 * O `target` casa tanto contra o nome do campo (ex.: "checkout_key") quanto o
 * nome da constraint (ex.: "orders_checkout_key_key"). Reconhece os DOIS shapes
 * de P2002:
 *  - Prisma <=6 / compat: `meta.target` (string | string[] com os campos).
 *  - Prisma 7 (driver adapters): `meta.driverAdapterError.cause.constraint`
 *    com `{ fields: string[] }` e/ou `{ index: string }` (nome da constraint).
 *    Nesse shape `meta.target` NAO existe — por isso a deteccao por target
 *    precisa olhar o constraint do driver adapter, senao o catch de recuperacao
 *    do double-submit nunca e alcancado e o P2002 vaza ao chamador.
 */
function isUniqueViolation(err: unknown, target?: string): boolean {
  const e = err as {
    code?: string;
    meta?: {
      target?: unknown;
      driverAdapterError?: {
        cause?: { constraint?: { fields?: unknown; index?: unknown } | string };
      };
    };
  };
  if (e?.code !== "P2002") return false;
  if (!target) return true;

  const hit = (value: unknown): boolean => String(value ?? "").includes(target);

  // Compat: meta.target (Prisma <=6).
  const t = e.meta?.target;
  if (Array.isArray(t) ? t.some(hit) : hit(t)) return true;

  // Prisma 7: meta.driverAdapterError.cause.constraint ({ fields, index } | nome).
  const constraint = e.meta?.driverAdapterError?.cause?.constraint;
  if (typeof constraint === "string") return hit(constraint);
  if (constraint) {
    const fields = constraint.fields;
    if (Array.isArray(fields) ? fields.some(hit) : hit(fields)) return true;
    if (hit(constraint.index)) return true;
  }
  return false;
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
    ? {
        timeout: 15000,
        maxWait: 5000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }
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
            customerDocument: input.customerDocument ?? null,
            addressCep: input.address.cep,
            addressStreet: input.address.street,
            addressNumber: input.address.number,
            addressComplement: input.address.complement,
            addressDistrict: input.address.district,
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
            shippingServiceCode: input.shippingServiceCode ?? null,
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
  | { found: true; ok: false; reason: "payment_mismatch" | "value_mismatch" | "invalid_transition" }
  | {
      found: true;
      ok: true;
      changed: boolean;
      previousStatus: PaymentStatus;
      status: PaymentStatus;
      /**
       * Pedido COMPLETO (com itens) ja com o paymentStatus = `status` aplicado,
       * para o e-mail de confirmacao sem uma leitura extra (getOrderById). Lido na
       * MESMA query inicial; o paymentStatus e ajustado para o novo `status` porque
       * o row foi lido ANTES do compare-and-swap.
       */
      order: Order;
    };

/**
 * Maquina de estados de pagamento: transicoes VALIDAS de mudanca (o no-op X->X e
 * tratado a parte). 'paid' so a partir de 'pending'; 'cancelled' de 'pending'
 * (expiracao) ou 'paid' (refund); 'paid' e 'cancelled' sao TERMINAIS (nunca voltam
 * a 'pending', e 'cancelled' nunca vira 'paid'). Aplicada em applyPaymentStatusTx
 * ANTES do CAS para que uma corrida nao force uma transicao impossivel.
 */
const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["cancelled"],
  cancelled: [],
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
  // Leitura UNICA e completa (com itens): serve tanto a verificacao/CAS quanto o
  // e-mail de confirmacao, evitando um getOrderById extra por pedido pago. As
  // flags de estoque saem deste MESMO row (sem 2 leituras, sem N+1 por item).
  const existing = await tx.order.findUnique({
    where: { id: orderId },
    include: withItems,
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

  // Guarda de transicao (ANTES de tocar no estoque). O CAS sozinho abaixo
  // (WHERE payment_status = previousStatus) aceitaria QUALQUER alvo, entao uma
  // transicao impossivel passaria sob corrida — ex.: ressuscitar 'cancelled'->'paid'
  // (o cron/expire ja cancelou+estornou; o reconcile de 'paid' nao baixa porque
  // reserved ja foi estornado => "pago sem baixa de estoque"), ou 'paid'->'pending'.
  // Validamos contra PAYMENT_TRANSITIONS; X->X cai no no-op idempotente adiante. Os
  // callers de producao (webhook EVENT_TO_STATUS, reconcile) so enviam 'paid'/
  // 'cancelled', mas a guarda torna o contrato defensivo por construcao.
  if (previousStatus !== status && !PAYMENT_TRANSITIONS[previousStatus].includes(status)) {
    console.error(
      `[orders] transicao de pagamento invalida p/ pedido #${orderId}: ${previousStatus} -> ${status}; ignorada (sem efeito em estoque). cancelled->paid pode indicar pagamento real apos cancelamento, a reconciliar manualmente.`,
    );
    return { found: true, ok: false, reason: "invalid_transition" };
  }

  // Snapshot de estoque derivado do mesmo row (nao uma segunda leitura).
  const stockSnapshot: StockSnapshot = {
    stockReserved: existing.stockReserved,
    stockCommitted: existing.stockCommitted,
    items: existing.items.map((it) => ({ productId: it.productId, quantity: it.quantity })),
  };
  // Conciliacao de estoque idempotente (guardada por flags), independente do CAS.
  // `effect` informa se ESTA transacao reivindicou a transicao de estoque (CAS=1)
  // ou se foi um no-op (replay/corrida). Auditamos EXATAMENTE o efeito reivindicado.
  const effect = await reconcileStockForPaymentStatus(tx, orderId, status, stockSnapshot);

  // Auditoria do efeito do webhook na MESMA transacao (audit-same-tx). O fluxo e de
  // SISTEMA (ator anonimo), entao so deixamos trilha quando o efeito FOI aplicado
  // por esta tx (effect !== 'none'); como o CAS das flags so deixa UMA transacao
  // reivindicar a transicao, sob reentrega do MESMO evento as demais entregas acham
  // a flag ja virada -> effect='none' -> 0 audit. Idempotencia da auditoria herda a
  // do efeito: exatamente 1 linha por commit/release/restock, jamais duplicada.
  if (effect !== "none") {
    await writeWebhookStockAuditLog(tx, orderId, previousStatus, status, effect, stockSnapshot);
  }

  // Pedido p/ o e-mail: o row foi lido ANTES do CAS, entao reflete o paymentStatus
  // NOVO (`status`), nao o antigo. So o paymentStatus muda; itens/totais ja batem.
  const order: Order = { ...toOrder(existing), paymentStatus: status };

  if (previousStatus === status) {
    return { found: true, ok: true, changed: false, previousStatus, status, order };
  }

  // Compare-and-swap: so escreve se o status ainda for o que lemos.
  const res = await tx.order.updateMany({
    where: { id: orderId, paymentStatus: previousStatus },
    data: { paymentStatus: status },
  });
  return { found: true, ok: true, changed: res.count > 0, previousStatus, status, order };
}

/** Ator anonimo de SISTEMA (webhook/reconcile) — sem usuario Clerk, como mock-first. */
const SYSTEM_ACTOR: AuditActor = { clerkUserId: null, email: null, role: null };

/**
 * Grava 1 linha de audit_log do EFEITO de estoque reivindicado pelo fluxo de
 * SISTEMA (webhook/reconcile), na MESMA transacao do efeito (audit-same-tx). So e
 * chamada quando reconcileStockForPaymentStatus reivindicou a transicao nesta tx
 * (effect !== 'none'), entao sob reentrega do mesmo evento ela roda no MAXIMO 1x —
 * a auditoria herda a idempotencia do CAS das flags. `after.systemFlow=true` e
 * `stockEffect` distinguem do ajuste MANUAL do admin (manualAdjustment=true).
 */
async function writeWebhookStockAuditLog(
  tx: Prisma.TransactionClient,
  orderId: number,
  previousStatus: PaymentStatus,
  status: PaymentStatus,
  effect: Exclude<StockReconcileEffect, "none">,
  snap: StockSnapshot,
): Promise<void> {
  await writeAuditLog(tx, {
    actor: SYSTEM_ACTOR,
    action: AuditAction.order_payment_status_update,
    entityType: AuditEntityType.order,
    entityId: String(orderId),
    before: {
      paymentStatus: previousStatus,
      stockReserved: snap.stockReserved,
      stockCommitted: snap.stockCommitted,
    },
    after: {
      paymentStatus: status,
      // Flags resultantes do CAS aplicado nesta tx: commit/release zeram a reserva;
      // commit comita, restock descomita; o que o efeito nao toca herda o snapshot.
      stockReserved: effect === "commit" || effect === "release" ? false : snap.stockReserved,
      stockCommitted:
        effect === "commit" ? true : effect === "restock" ? false : snap.stockCommitted,
      systemFlow: true,
      stockEffect: effect,
    },
  });
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

/**
 * Efeito de estoque que a conciliacao reivindicou nesta transacao (via CAS das
 * flags). `none` = nenhuma transicao reivindicada (no-op idempotente sob replay/
 * corrida). O chamador usa isto p/ auditar EXATAMENTE a mutacao que de fato
 * ocorreu, na MESMA tx (audit-same-tx) e UMA unica vez sob reentrega.
 */
type StockReconcileEffect = "none" | "commit" | "release" | "restock";

async function reconcileStockForPaymentStatus(
  tx: Prisma.TransactionClient,
  orderId: number,
  status: PaymentStatus,
  snap: StockSnapshot,
): Promise<StockReconcileEffect> {
  const lines = snap.items.map((it) => ({ productId: it.productId, quantity: it.quantity }));
  if (lines.length === 0) return "none";

  // CAS no PROPRIO pedido (nao no snapshot lido sem lock): o flip da flag e a
  // CONDICAO do UPDATE, que adquire o row-lock de "orders". Concorrentes (webhook
  // paid x cron/reconcile cancel; ou refunds duplicados) bloqueiam e, ao reler,
  // acham a flag ja virada -> 0 linhas -> no-op. So a transacao que efetivamente
  // transiciona a flag mexe no estoque. claimed=1 garante a pre-condicao do efeito
  // (reserva/baixa ainda intactas), entao os guards coluna-a-coluna do inventory
  // sempre casam. Fecha a corrida de snapshot stale (duplo-restock e "pago sem baixa").
  if (status === "paid") {
    const claimed = await tx.$executeRaw`
      UPDATE "orders" SET "stock_committed" = true, "stock_reserved" = false
      WHERE "id" = ${orderId} AND "stock_reserved" = true AND "stock_committed" = false
    `;
    if (claimed === 1) {
      await commitStock(tx, lines);
      return "commit";
    }
    return "none";
  }

  if (status === "cancelled") {
    // Estorno da reserva (pendente nao pago).
    const released = await tx.$executeRaw`
      UPDATE "orders" SET "stock_reserved" = false
      WHERE "id" = ${orderId} AND "stock_reserved" = true AND "stock_committed" = false
    `;
    if (released === 1) {
      await releaseStock(tx, lines);
      return "release";
    }
    // Refund/chargeback de pedido JA PAGO: repoe o estoque baixado (Q3). O CAS aqui
    // e o unico guard (restockUnits nao tem predicado de coluna proprio).
    const refunded = await tx.$executeRaw`
      UPDATE "orders" SET "stock_committed" = false
      WHERE "id" = ${orderId} AND "stock_committed" = true
    `;
    if (refunded === 1) {
      await restockUnits(tx, lines);
      return "restock";
    }
  }
  return "none";
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
  | { ok: false; reason: "payment_required"; from: ShippingStatus; to: ShippingStatus }
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
 *
 * REGRA: 'sent' exige paymentStatus='paid' — nunca despachamos o que nao foi pago.
 * O pagamento so muda por conta propria (webhook/reconcile/ajuste manual); virar
 * 'paid' NUNCA avanca o envio sozinho (o admin decide quando de fato despachou), e
 * o inverso tambem vale: marcar 'sent' exige o pagamento JA confirmado. Checado
 * ANTES do CAS (fail-fast com motivo claro) e REPETIDO no WHERE do UPDATE — fecha a
 * corrida com um refund/cancelamento de pagamento concorrente entre a leitura e a
 * escrita (senao o CAS de shippingStatus sozinho aceitaria despachar um pedido que
 * acabou de ser estornado no meio do caminho).
 */
export async function updateOrderShippingStatus(
  orderId: number,
  to: ShippingStatus,
  actor: AuditActor,
  ctx?: { requestId?: string | null; ip?: string | null },
): Promise<AdminOrderUpdate> {
  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.order.findUnique({
        where: { id: orderId },
        select: adminOrderSelect,
      });
      if (!existing) return { ok: false, reason: "not_found" } as const;

      const from = existing.shippingStatus as ShippingStatus;
      if (from === to) {
        return { ok: true, changed: false, order: await reloadOrder(tx, orderId) } as const;
      }
      if (!SHIPPING_TRANSITIONS[from].includes(to)) {
        return { ok: false, reason: "invalid_transition", from, to } as const;
      }
      if (to === "sent" && existing.paymentStatus !== "paid") {
        return { ok: false, reason: "payment_required", from, to } as const;
      }

      const res = await tx.order.updateMany({
        where: {
          id: orderId,
          shippingStatus: from,
          ...(to === "sent" ? { paymentStatus: "paid" } : {}),
        },
        data: { shippingStatus: to },
      });
      if (res.count === 0) {
        // count=0 tem duas causas possiveis: (a) outra chamada ja mudou o
        // shippingStatus (no-op benigno, comportamento pre-existente) ou (b), so
        // possivel quando to==='sent', o pagamento deixou de ser 'paid' ENTRE a
        // checagem acima e este UPDATE (refund/cancelamento concorrente) — nesse
        // caso NAO e um no-op qualquer, e a mesma rejeicao payment_required, so
        // que descoberta so na corrida.
        if (to === "sent") {
          const fresh = await tx.order.findUnique({
            where: { id: orderId },
            select: { shippingStatus: true, paymentStatus: true },
          });
          if (fresh?.shippingStatus === from && fresh.paymentStatus !== "paid") {
            return { ok: false, reason: "payment_required", from, to } as const;
          }
        }
        return { ok: true, changed: false, order: await reloadOrder(tx, orderId) } as const;
      }

      // Cancelar envio libera/repoe estoque (alinhado ao refund do webhook).
      let paymentAfter = existing.paymentStatus as PaymentStatus;
      if (to === "cancelled") {
        await reconcileStockForPaymentStatus(tx, orderId, "cancelled", existing);
        // Cancelar o ENVIO de um pedido ainda PENDENTE de pagamento tambem CANCELA o
        // pagamento na MESMA tx. Sem isto a reserva acaba de ser liberada mas o PIX
        // segue pagavel: um webhook 'paid' posterior faz a transicao LEGAL
        // pending->paid, porem o CAS de 'paid' nao acha stock_reserved=true (ja
        // liberado) e NAO baixa => pedido PAGO sem baixa de estoque, e a unidade
        // liberada pode ser revendida = oversell. Espelha cancelOrderAndReleaseStock
        // (cron), que acopla os dois flips: com payment='cancelled' (terminal), o
        // pending->paid posterior vira invalid_transition e e rejeitado. CAS
        // WHERE payment_status='pending' para nao sobrescrever um pagamento concorrente
        // (o row ja esta lockado por este UPDATE, entao um webhook paralelo serializa e
        // rele 'cancelled' => cancelled->paid invalido).
        if (existing.paymentStatus === "pending") {
          const cancelledPayment = await tx.order.updateMany({
            where: { id: orderId, paymentStatus: "pending" },
            data: { paymentStatus: "cancelled" },
          });
          if (cancelledPayment.count > 0) paymentAfter = "cancelled";
        }
      }

      await writeAuditLog(tx, {
        actor,
        action: AuditAction.order_shipping_status_update,
        entityType: AuditEntityType.order,
        entityId: String(orderId),
        before: orderAuditSnapshot(existing),
        after: orderAuditSnapshot({ ...existing, shippingStatus: to, paymentStatus: paymentAfter }),
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
      const existing = await tx.order.findUnique({
        where: { id: orderId },
        select: adminOrderSelect,
      });
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
 * Preenche/atualiza o RASTREIO do pedido (admin): codigo + transportador. Grava
 * audit_log na MESMA transacao (invariante 3). Normaliza: codigo vazio -> null;
 * carrier so aceito se for um id conhecido (lib/data/carriers), senao null.
 * Idempotente: mesmo par (codigo, carrier) = no-op (sem audit ruidoso).
 */
export async function updateOrderTracking(
  orderId: number,
  input: { trackingCode: string | null; carrier: string | null },
  actor: AuditActor,
  ctx?: { requestId?: string | null; ip?: string | null },
): Promise<AdminOrderUpdate> {
  const trackingCode =
    input.trackingCode && input.trackingCode.trim().length > 0 ? input.trackingCode.trim() : null;
  // Transportador sem codigo nao tem sentido (nem aparece na vitrine, que exibe o
  // bloco so quando ha codigo): sem codigo -> carrier tambem null. Mantem estado
  // persistido == estado exibido e evita audit "changed" de dado invisivel.
  const carrier =
    trackingCode && input.carrier && isCarrierId(input.carrier) ? input.carrier : null;

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.order.findUnique({
        where: { id: orderId },
        select: { trackingCode: true, shippingCarrier: true },
      });
      if (!existing) return { ok: false, reason: "not_found" } as const;

      if (
        (existing.trackingCode ?? null) === trackingCode &&
        (existing.shippingCarrier ?? null) === carrier
      ) {
        return { ok: true, changed: false, order: await reloadOrder(tx, orderId) } as const;
      }

      await tx.order.update({
        where: { id: orderId },
        data: { trackingCode, shippingCarrier: carrier },
      });

      await writeAuditLog(tx, {
        actor,
        action: AuditAction.order_tracking_update,
        entityType: AuditEntityType.order,
        entityId: String(orderId),
        before: {
          trackingCode: existing.trackingCode ?? null,
          shippingCarrier: existing.shippingCarrier ?? null,
        },
        after: { trackingCode, shippingCarrier: carrier },
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
      const existing = await tx.order.findUnique({
        where: { id: orderId },
        select: adminOrderSelect,
      });
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
          items: { select: { productId: true, quantity: true } },
        },
      });
      if (!existing) return { released: false };
      const lines = existing.items.map((it) => ({
        productId: it.productId,
        quantity: it.quantity,
      }));

      // CAS (mesmo principio de reconcileStockForPaymentStatus): estorna a reserva
      // SO se ainda pendente-reservada-e-nao-committed, no proprio UPDATE que
      // adquire o row-lock. Concorrente com o webhook paid, um dos lados vira no-op.
      const released = await tx.$executeRaw`
        UPDATE "orders" SET "stock_reserved" = false, "payment_status" = 'cancelled'
        WHERE "id" = ${orderId}
          AND "stock_reserved" = true AND "stock_committed" = false
          AND "payment_status" = 'pending'
      `;
      if (released === 1) {
        await releaseStock(tx, lines);
        return { released: true };
      }
      // Sem reserva ativa a estornar: so coerencia de status (so atinge pending).
      await tx.$executeRaw`
        UPDATE "orders" SET "payment_status" = 'cancelled'
        WHERE "id" = ${orderId} AND "payment_status" = 'pending'
      `;
      return { released: false };
    },
    { timeout: 15000, maxWait: 5000 },
  );
}

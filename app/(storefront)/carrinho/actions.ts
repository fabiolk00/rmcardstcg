"use server";

import { auth } from "@clerk/nextjs/server";

import { couponDiscountCents, couponErrorMessage } from "@/lib/cart/coupon";
import { cartTotals, type CartLine } from "@/lib/cart/totals";
import { redeemCoupon, validateCoupon } from "@/lib/data/coupons";
import {
  createOrderWithReservation,
  findOrderByCheckoutKey,
  getOrderAsaasRefs,
  setOrderAsaasRefs,
} from "@/lib/data/orders";
import { finalPriceCents } from "@/lib/data/pricing";
import { getProductsByIds } from "@/lib/data/products";
import type { Order, OrderItem } from "@/lib/data/types";
import { AsaasError } from "@/lib/services/asaas/client";
import { isAsaasConfigured } from "@/lib/services/asaas/config";
import { createCustomer, createPixCharge, getPixQrCode } from "@/lib/services/asaas/payments";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { sendOrderConfirmationEmail } from "@/lib/services/resend";

/**
 * Server action de checkout — cria o pedido (pending) + reserva de estoque e a
 * cobranca PIX no Asaas, de forma IDEMPOTENTE.
 *
 * Idempotencia (invariante 2): o cliente envia uma checkoutKey estavel por
 * tentativa. findOrderByCheckoutKey ANTES de qualquer write; se ja existe, reusa
 * o MESMO pedido e a MESMA cobranca Asaas (so re-deriva o QR), sem criar
 * customer/payment de novo. Reserva de estoque atomica (invariante 1) dentro da
 * transacao de createOrderWithReservation.
 *
 * Mock-first: sem chave do Asaas o pedido e criado mesmo assim (pix: null). Precos
 * e totais sao SEMPRE recalculados no servidor a partir do banco.
 */

const PIX_DUE_DAYS = 3;

export type CheckoutCustomer = {
  name: string;
  email: string;
  phone: string;
  cpfCnpj?: string;
  cep: string;
  street: string;
  city: string;
  state: string;
};

export type CheckoutInput = {
  /**
   * Chave de idempotencia do checkout (invariante 2). Gerada no client
   * (crypto.randomUUID por sessao de carrinho) e reenviada em cada submit/retry.
   * Mesma chave => mesmo pedido e mesma cobranca Asaas (duplo-clique nao duplica).
   */
  checkoutKey: string;
  customer: CheckoutCustomer;
  items: { productId: string; quantity: number }[];
  /** Codigo de cupom digitado pelo cliente (validado 100% no server). */
  couponCode?: string;
};

export type CheckoutPix = {
  payload: string;
  encodedImage: string;
  expirationDate: string;
};

export type CheckoutResult =
  | {
      ok: true;
      orderId: string;
      /** null quando o Asaas nao esta configurado (dev sem chave). */
      pix: CheckoutPix | null;
      invoiceUrl: string | null;
    }
  | { ok: false; error: string };

const onlyDigits = (s: string) => s.replace(/\D/g, "");

/** Vencimento da cobranca PIX (hoje + N dias) como Date — fonte do due_date. */
function pixDueDateObject(): Date {
  const d = new Date();
  d.setDate(d.getDate() + PIX_DUE_DAYS);
  return d;
}

/** Vencimento da cobranca PIX no formato YYYY-MM-DD (exigido pelo Asaas). */
function pixDueDate(): string {
  return pixDueDateObject().toISOString().slice(0, 10);
}

/** Erro de redencao de cupom — sinaliza rollback da transacao do checkout. */
class CouponRedeemError extends Error {}

/** Best-effort: busca o QR PIX de uma cobranca existente; null se indisponivel. */
async function fetchPix(paymentId: string): Promise<CheckoutPix | null> {
  try {
    const qr = await getPixQrCode(paymentId);
    return {
      payload: qr.payload,
      encodedImage: qr.encodedImage,
      expirationDate: qr.expirationDate,
    };
  } catch (qrErr) {
    console.warn(
      "[checkout] QR PIX indisponivel (cadastre uma chave PIX no Asaas):",
      qrErr instanceof Error ? qrErr.message : qrErr,
    );
    return null;
  }
}

export async function checkout(input: CheckoutInput): Promise<CheckoutResult> {
  if (!input.checkoutKey) {
    return { ok: false, error: "Sessão de checkout inválida. Recarregue a página." };
  }
  if (!input.items?.length) {
    return { ok: false, error: "Seu carrinho está vazio." };
  }

  // Usuario: vem do Clerk quando configurado; senao "guest" (mock-first).
  let userId = "guest";
  if (isClerkConfigured()) {
    const { userId: clerkId } = await auth();
    if (!clerkId) return { ok: false, error: "Faça login para finalizar a compra." };
    userId = clerkId;
  }

  // IDEMPOTENCIA: se esta chave ja gerou um pedido, reaproveita-o (nunca recria
  // pedido nem cobranca Asaas — so re-deriva o PIX da cobranca existente).
  const prior = await findOrderByCheckoutKey(input.checkoutKey);
  if (prior) return resultForExistingOrder(prior);

  // Revalida cada item: existe e ativo. Monta snapshots + linhas. A disponibilidade
  // real de estoque e garantida atomicamente pela reserva (nao por read antecipado).
  const orderItems: OrderItem[] = [];
  const lines: CartLine[] = [];
  // Batch: carrega todos os produtos do carrinho numa unica query (evita N+1;
  // antes era um getProductById por item). A disponibilidade real de estoque
  // continua garantida atomicamente pela reserva, nao por este read.
  const products = await getProductsByIds(input.items.map((i) => i.productId));
  const productById = new Map(products.map((p) => [p.id, p]));
  for (const { productId, quantity } of input.items) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: "Quantidade inválida no carrinho." };
    }
    const product = productById.get(productId);
    if (!product || !product.isActive) {
      return { ok: false, error: "Um dos produtos não está mais disponível." };
    }
    orderItems.push({
      productId: product.id,
      productName: product.name,
      quantity,
      unitPriceCents: finalPriceCents(product),
    });
    lines.push({ product, quantity });
  }

  const totals = cartTotals(lines);

  // Cupom (100% server-side): so aceita se valido para ESTE carrinho/usuario.
  // Incide sobre merchandiseCents; recalculado aqui (o cliente so manda o codigo).
  // Semantica (Q4-B): discountCents = desconto de PRODUTO; couponDiscountCents =
  // desconto de CUPOM; total = subtotal - discountCents - couponDiscountCents + frete.
  let appliedCouponCode: string | null = null;
  let appliedCouponId: string | null = null;
  let appliedCouponDiscountCents = 0;
  let couponMaxRedemptions: number | null = null;
  let couponPerUserLimit: number | null = null;

  const rawCode = input.couponCode?.trim();
  if (rawCode) {
    const v = await validateCoupon({
      code: rawCode,
      merchandiseCents: totals.merchandiseCents,
      userId,
    });
    if (!v.ok) return { ok: false, error: couponErrorMessage(v.reason) };
    appliedCouponCode = v.coupon.code;
    appliedCouponId = v.coupon.id;
    couponMaxRedemptions = v.coupon.maxRedemptions;
    couponPerUserLimit = v.coupon.perUserLimit;
    appliedCouponDiscountCents = couponDiscountCents(v.coupon, totals.merchandiseCents);
  }

  const finalTotalCents = Math.max(
    totals.shippingCents,
    totals.totalCents - appliedCouponDiscountCents,
  );

  // Cria o pedido pendente, reserva o estoque E redime o cupom na MESMA transacao
  // (atomicidade + idempotencia). Corrida de chave (duplo-clique) que perca o
  // INSERT e tratada como reaproveitamento. Redencao que falhe faz rollback total.
  const created = await createOrderWithReservation(
    {
      checkoutKey: input.checkoutKey,
      userId,
      customerName: input.customer.name,
      customerEmail: input.customer.email,
      customerPhone: input.customer.phone,
      address: {
        cep: input.customer.cep,
        street: input.customer.street,
        city: input.customer.city,
        state: input.customer.state,
      },
      items: orderItems,
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      couponCode: appliedCouponCode,
      couponDiscountCents: appliedCouponDiscountCents,
      shippingCents: totals.shippingCents,
      totalCents: finalTotalCents,
      paymentMethod: "PIX",
      dueDate: pixDueDateObject(),
    },
    appliedCouponId
      ? async (tx, orderId) => {
          const r = await redeemCoupon(tx, {
            couponId: appliedCouponId as string,
            orderId,
            userId,
            discountCents: appliedCouponDiscountCents,
            perUserLimit: couponPerUserLimit,
            maxRedemptions: couponMaxRedemptions,
          });
          if (!r.ok) throw new CouponRedeemError(couponErrorMessage(r.reason));
        }
      : undefined,
  ).catch((err: unknown) => {
    if (err instanceof CouponRedeemError) {
      return { ok: false as const, reason: "coupon" as const, message: err.message };
    }
    throw err;
  });

  if (!created.ok) {
    if ("reason" in created && created.reason === "coupon") {
      return { ok: false, error: created.message };
    }
    const productId = "productId" in created ? created.productId : undefined;
    const name = orderItems.find((it) => it.productId === productId)?.productName;
    return { ok: false, error: `Estoque insuficiente para "${name ?? "um item"}".` };
  }

  // Pedido reaproveitado por corrida de chave: re-deriva o PIX, nao recria cobranca.
  if (created.reused) return resultForExistingOrder(created.order);

  const order = created.order;

  // Confirmacao de "pedido recebido" (mock-first: no-op sem Resend; tolerante a falha).
  await sendOrderConfirmationEmail(order);

  // Sem Asaas configurado (dev sem chave): pedido criado/reservado, sem cobranca.
  if (!isAsaasConfigured()) {
    return { ok: true, orderId: order.id, pix: null, invoiceUrl: null };
  }

  const externalReference = order.id.replace(/^#/, "");

  try {
    const customer = await createCustomer({
      name: input.customer.name,
      email: input.customer.email,
      mobilePhone: onlyDigits(input.customer.phone),
      cpfCnpj: input.customer.cpfCnpj ? onlyDigits(input.customer.cpfCnpj) : undefined,
    });

    const payment = await createPixCharge({
      customerId: customer.id,
      valueCents: order.totalCents,
      externalReference,
      dueDate: pixDueDate(),
      description: `Pedido ${order.id} — RM Cards`,
    });

    try {
      await setOrderAsaasRefs(Number(externalReference), {
        paymentId: payment.id,
        customerId: customer.id,
      });
    } catch (refErr) {
      console.error(
        `[checkout] falha ao gravar refs Asaas do pedido ${order.id}:`,
        refErr instanceof Error ? refErr.message : refErr,
      );
    }

    const pix = await fetchPix(payment.id);
    return { ok: true, orderId: order.id, pix, invoiceUrl: payment.invoiceUrl };
  } catch (err) {
    // O pedido ja existe (pending, estoque reservado); so a cobranca falhou. Reenviar
    // com a MESMA checkoutKey cai no curto-circuito de idempotencia.
    const message =
      err instanceof AsaasError
        ? `Não foi possível gerar o PIX: ${err.message}`
        : "Não foi possível gerar a cobrança. Tente novamente.";
    console.error(
      "[checkout] falha ao criar cobranca Asaas:",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, error: message };
  }
}

/**
 * CheckoutResult para um pedido que JA existe (retry idempotente). Reaproveita a
 * cobranca Asaas ja criada (re-deriva so o QR); se ainda nao ha cobranca vinculada
 * (1a tentativa falhou antes do setOrderAsaasRefs), tenta cria-la uma vez.
 */
async function resultForExistingOrder(order: Order): Promise<CheckoutResult> {
  if (!isAsaasConfigured()) {
    return { ok: true, orderId: order.id, pix: null, invoiceUrl: null };
  }

  const externalReference = order.id.replace(/^#/, "");
  const refs = await getOrderAsaasRefs(Number(externalReference));

  if (refs?.paymentId) {
    const pix = await fetchPix(refs.paymentId);
    return { ok: true, orderId: order.id, pix, invoiceUrl: null };
  }

  try {
    const customer = await createCustomer({
      name: order.customerName,
      email: order.customerEmail,
      mobilePhone: onlyDigits(order.customerPhone),
    });
    const payment = await createPixCharge({
      customerId: customer.id,
      valueCents: order.totalCents,
      externalReference,
      dueDate: pixDueDate(),
      description: `Pedido ${order.id} — RM Cards`,
    });
    try {
      await setOrderAsaasRefs(Number(externalReference), {
        paymentId: payment.id,
        customerId: customer.id,
      });
    } catch (refErr) {
      console.error(
        `[checkout] falha ao gravar refs Asaas (retry) do pedido ${order.id}:`,
        refErr instanceof Error ? refErr.message : refErr,
      );
    }
    const pix = await fetchPix(payment.id);
    return { ok: true, orderId: order.id, pix, invoiceUrl: payment.invoiceUrl };
  } catch (err) {
    console.error(
      "[checkout] falha ao recriar cobranca Asaas (retry):",
      err instanceof Error ? err.message : err,
    );
    const message =
      err instanceof AsaasError
        ? `Não foi possível gerar o PIX: ${err.message}`
        : "Não foi possível gerar a cobrança. Tente novamente.";
    return { ok: false, error: message };
  }
}

"use server";

import { auth } from "@clerk/nextjs/server";

import { DEACTIVATED_ACCOUNT_ERROR, requireActiveUser } from "@/lib/auth/requireActiveUser";
import { couponDiscountCents, couponErrorMessage } from "@/lib/cart/coupon";
import { cartTotals, FLAT_SHIPPING_CENTS, type CartLine } from "@/lib/cart/totals";
import { isFreeShipping, resolveShippingCents } from "@/lib/cart/shipping";
import { effectivePackage } from "@/lib/services/superfrete/dimensions";
import { quoteShipping, type ShippingOption } from "@/lib/services/superfrete/quote";
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
import { createCharge, createCustomer, getPayment, getPixQrCode } from "@/lib/services/asaas/payments";
import {
  dueDateForMethod,
  normalizePaymentMethod,
  paymentBillingType,
} from "@/lib/payments/method";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { sendOrderConfirmationEmail } from "@/lib/services/resend";
import { clientRateLimitKey } from "@/lib/security/clientKey";
import { checkRateLimit } from "@/lib/security/rateLimit";

/**
 * Server action de checkout — cria o pedido (pending) + reserva de estoque e a
 * cobranca (PIX ou cartao a vista) no Asaas, de forma IDEMPOTENTE.
 *
 * Idempotencia (invariante 2): o cliente envia uma checkoutKey estavel por
 * tentativa. findOrderByCheckoutKey ANTES de qualquer write; se ja existe, reusa
 * o MESMO pedido e a MESMA cobranca Asaas (so re-deriva o QR/fatura), sem criar
 * customer/payment de novo. Reserva de estoque atomica (invariante 1) dentro da
 * transacao de createOrderWithReservation.
 *
 * Mock-first: sem chave do Asaas o pedido e criado mesmo assim (pix: null). Precos
 * e totais sao SEMPRE recalculados no servidor a partir do banco.
 */

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
  /**
   * Consentimento explicito aos Termos de uso e a Politica de privacidade (LGPD).
   * A UI trava o submit sem o aceite; o server RE-valida (defense in depth): pedido
   * so e criado com aceite verdadeiro.
   */
  acceptedTerms: boolean;
  /** Codigo de cupom digitado pelo cliente (validado 100% no server). */
  couponCode?: string;
  /**
   * Servico de frete escolhido pelo cliente (1=PAC, 2=SEDEX, ...). O server RE-COTA
   * e bate por este codigo; se nao casar, usa o mais barato. Frete e sempre resolvido
   * no servidor (nunca confia no preco do client) — fecha "exibido == cobrado".
   */
  shippingServiceCode?: number;
  /**
   * Metodo de pagamento escolhido ("pix" | "card"). O server NORMALIZA e re-decide
   * billingType/dueDate a partir do slug (nunca confia no client); ausente/invalido
   * cai em "pix" (retrocompativel — o checkout era PIX-only).
   */
  paymentMethod?: string;
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
      /** null quando o Asaas nao esta configurado (dev sem chave) ou o metodo e cartao. */
      pix: CheckoutPix | null;
      invoiceUrl: string | null;
    }
  | { ok: false; error: string };

const onlyDigits = (s: string) => s.replace(/\D/g, "");

/** Vencimento (YYYY-MM-DD, exigido pelo Asaas) a partir do Date do due_date. */
function dueDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
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

/** Best-effort: URL da fatura hospedada (cartao) de uma cobranca; null se indisponivel. */
async function fetchInvoiceUrl(paymentId: string): Promise<string | null> {
  try {
    const payment = await getPayment(paymentId);
    return payment.invoiceUrl ?? null;
  } catch (err) {
    console.warn("[checkout] invoiceUrl indisponivel:", err instanceof Error ? err.message : err);
    return null;
  }
}

export type CouponPreview =
  | { ok: true; code: string; discountCents: number; finalTotalCents: number }
  | { ok: false; error: string };

/**
 * Previa de cupom para a UI de checkout (server-only; a validacao do cupom vive no
 * servidor). Recalcula desconto e total final do MESMO jeito que o checkout, para a
 * tela exibir o valor que sera de fato cobrado — fim do "mostra X, cobra Y".
 */
export async function previewCoupon(input: {
  items: { productId: string; quantity: number }[];
  couponCode: string;
}): Promise<CouponPreview> {
  const code = input.couponCode?.trim();
  if (!code) return { ok: false, error: "Informe um cupom." };
  if (!input.items?.length) return { ok: false, error: "Seu carrinho está vazio." };

  // Login + espelho ATIVO (cupom e por-usuario; soft-deleted nao valida).
  const activeCoupon = await requireActiveUser();
  if (!activeCoupon.ok) {
    const error =
      activeCoupon.reason === "deleted"
        ? DEACTIVATED_ACCOUNT_ERROR
        : "Faça login para usar um cupom.";
    return { ok: false, error };
  }
  const userId = activeCoupon.userId;

  const limited = await checkRateLimit(`coupon-preview:${await clientRateLimitKey(userId)}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!limited.allowed) {
    return { ok: false, error: "Muitas tentativas. Aguarde um instante." };
  }

  const products = await getProductsByIds(input.items.map((i) => i.productId));
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: CartLine[] = [];
  for (const { productId, quantity } of input.items) {
    const product = byId.get(productId);
    if (!product || !product.isActive) {
      return { ok: false, error: "Um dos produtos não está mais disponível." };
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: "Quantidade inválida no carrinho." };
    }
    lines.push({ product, quantity });
  }

  const totals = cartTotals(lines);
  const v = await validateCoupon({ code, merchandiseCents: totals.merchandiseCents, userId });
  if (!v.ok) return { ok: false, error: couponErrorMessage(v.reason) };

  const discountCents = couponDiscountCents(v.coupon, totals.merchandiseCents);
  const finalTotalCents = Math.max(totals.shippingCents, totals.totalCents - discountCents);
  return { ok: true, code: v.coupon.code, discountCents, finalTotalCents };
}

export type ShippingQuoteResult =
  | { ok: true; free: boolean; options: ShippingOption[] }
  | { ok: false; error: string };

/**
 * Cotacao de frete para a tela de checkout. Server-side: valida CEP/itens, decide
 * frete GRATIS pela mercadoria (limiar) e, quando pago, cota no SuperFrete. Mock-first
 * / indisponivel -> uma opcao unica de frete flat, para a UX funcionar ja hoje (sem
 * token) e exibir o total. O preco final do pedido e SEMPRE re-resolvido no checkout.
 */
export async function quoteShippingAction(input: {
  cep: string;
  items: { productId: string; quantity: number }[];
}): Promise<ShippingQuoteResult> {
  if (!input.items?.length) return { ok: false, error: "Seu carrinho está vazio." };
  const dest = input.cep?.replace(/\D/g, "") ?? "";
  if (dest.length !== 8) return { ok: false, error: "Informe um CEP válido (8 dígitos)." };

  let userId = "guest";
  if (isClerkConfigured()) {
    const { userId: clerkId } = await auth();
    if (clerkId) userId = clerkId;
  }
  const limited = await checkRateLimit(`shipping-quote:${await clientRateLimitKey(userId)}`, {
    limit: 30,
    windowMs: 60_000,
  });
  if (!limited.allowed) return { ok: false, error: "Muitas tentativas. Aguarde um instante." };

  // Mercadoria a partir do BANCO (nunca confia no client) -> decide frete gratis.
  const products = await getProductsByIds(input.items.map((i) => i.productId));
  const byId = new Map(products.map((p) => [p.id, p]));
  const lines: CartLine[] = [];
  for (const { productId, quantity } of input.items) {
    const product = byId.get(productId);
    if (!product || !product.isActive) {
      return { ok: false, error: "Um dos produtos não está mais disponível." };
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: "Quantidade inválida no carrinho." };
    }
    lines.push({ product, quantity });
  }
  const totals = cartTotals(lines);
  if (isFreeShipping(totals.merchandiseCents)) return { ok: true, free: true, options: [] };

  // Itens de cotacao com as medidas EFETIVAS do produto (byId tem o Product completo;
  // CartLine.product e um Pick sem category/dimensoes).
  const quoteItems = input.items.flatMap((i) => {
    const product = byId.get(i.productId);
    return product
      ? [
          {
            quantity: i.quantity,
            pkg: effectivePackage(product),
            // Valor da MERCADORIA (com desconto) para o valor declarado/seguro.
            unitPriceCents: finalPriceCents(product),
          },
        ]
      : [];
  });
  let options: ShippingOption[] = [];
  try {
    options = await quoteShipping(input.cep, quoteItems);
  } catch (err) {
    console.error("[shipping-quote] falhou:", err instanceof Error ? err.message : err);
  }
  if (options.length === 0) {
    // Mock-first / indisponivel: frete flat como opcao unica (serviceCode 0).
    options = [
      {
        serviceCode: 0,
        name: "Frete padrão",
        carrier: null,
        priceCents: FLAT_SHIPPING_CENTS,
        days: null,
      },
    ];
  }
  return { ok: true, free: false, options };
}

export async function checkout(input: CheckoutInput): Promise<CheckoutResult> {
  if (!input.checkoutKey) {
    return { ok: false, error: "Sessão de checkout inválida. Recarregue a página." };
  }
  if (!input.items?.length) {
    return { ok: false, error: "Seu carrinho está vazio." };
  }
  // Consentimento LGPD obrigatorio (re-validado no server; a UI ja trava o submit).
  if (input.acceptedTerms !== true) {
    return {
      ok: false,
      error: "É necessário aceitar os Termos de uso e a Política de privacidade.",
    };
  }

  // Usuario: Clerk quando configurado (login + espelho ATIVO — conta desativada
  // NAO cria pedido novo); senao "guest" (mock-first).
  const activeUser = await requireActiveUser();
  if (!activeUser.ok) {
    const error =
      activeUser.reason === "deleted"
        ? DEACTIVATED_ACCOUNT_ERROR
        : "Faça login para finalizar a compra.";
    return { ok: false, error };
  }
  const userId = activeUser.userId;

  // IDEMPOTENCIA: se esta chave ja gerou um pedido, reaproveita-o (nunca recria
  // pedido nem cobranca Asaas — so re-deriva o PIX/fatura da cobranca existente).
  const prior = await findOrderByCheckoutKey(input.checkoutKey);
  if (prior) return resultForExistingOrder(prior);

  // Rate limit DEPOIS do short-circuit idempotente (retries da MESMA checkoutKey ja
  // retornaram acima), p/ nao penalizar reenvio legitimo. Best-effort em memoria;
  // em producao, injete um store compartilhado (ver lib/security/rateLimit).
  const limited = await checkRateLimit(`checkout:${await clientRateLimitKey(userId)}`, {
    limit: 12,
    windowMs: 60_000,
  });
  if (!limited.allowed) {
    return {
      ok: false,
      error: "Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.",
    };
  }

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

  // FRETE (custo + free), resolvido no SERVIDOR. Gratis no limiar; senao re-cota no
  // SuperFrete (mock-first -> []), casa pelo servico escolhido (ou o mais barato) e
  // cai no flat se a cotacao nao vier. O cliente NUNCA define o preco do frete.
  let quotedShippingCents: number | null = null;
  let shippingService: string | null = null;
  let shippingDays: string | null = null;
  if (!isFreeShipping(totals.merchandiseCents)) {
    try {
      const quoteItems = input.items.flatMap((i) => {
        const product = productById.get(i.productId);
        return product
          ? [
              {
                quantity: i.quantity,
                pkg: effectivePackage(product),
                // Mesmo valor unitario que compoe a mercadoria cobrada (com desconto).
                unitPriceCents: finalPriceCents(product),
              },
            ]
          : [];
      });
      const options = await quoteShipping(input.customer.cep, quoteItems);
      const chosen = options.find((o) => o.serviceCode === input.shippingServiceCode) ?? options[0];
      if (chosen) {
        quotedShippingCents = chosen.priceCents;
        shippingService = chosen.name;
        shippingDays = chosen.days != null ? `${chosen.days} dias úteis` : null;
      }
    } catch (err) {
      // Cotacao indisponivel nao derruba o checkout: cai no frete flat.
      console.error(
        "[checkout] cotacao de frete falhou; usando frete flat:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const shippingCents = resolveShippingCents({
    merchandiseCents: totals.merchandiseCents,
    quotedCents: quotedShippingCents,
  });

  // Total = mercadoria + frete resolvido - cupom, com piso no frete (cupom nunca
  // derruba abaixo do transporte ja cobrado).
  const finalTotalCents = Math.max(
    shippingCents,
    totals.merchandiseCents + shippingCents - appliedCouponDiscountCents,
  );

  // Metodo de pagamento (pix | card) NORMALIZADO no server. Deriva billingType e o
  // vencimento (pix: +1d; card: +3d — janela maior p/ o fluxo customer-paced da
  // fatura hospedada, ver lib/payments/method). O due_date alimenta o pg_cron de
  // expiracao; billingType decide a forma de cobranca no Asaas.
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  const billingType = paymentBillingType(paymentMethod);
  const dueAt = dueDateForMethod(paymentMethod);

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
      shippingCents,
      shippingService,
      shippingDays,
      totalCents: finalTotalCents,
      paymentMethod,
      dueDate: dueAt,
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

  // Pedido reaproveitado por corrida de chave: re-deriva o PIX/fatura, nao recria cobranca.
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

    const payment = await createCharge({
      customerId: customer.id,
      billingType,
      valueCents: order.totalCents,
      externalReference,
      dueDate: dueDateStr(dueAt),
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

    // Cartao: sem QR PIX — a fatura hospedada (invoiceUrl) e o meio de pagamento.
    // Evita um round-trip a /pixQrCode (que erraria) por cobranca de cartao.
    if (paymentMethod === "card") {
      return { ok: true, orderId: order.id, pix: null, invoiceUrl: payment.invoiceUrl };
    }
    const pix = await fetchPix(payment.id);
    return { ok: true, orderId: order.id, pix, invoiceUrl: payment.invoiceUrl };
  } catch (err) {
    // O pedido ja existe (pending, estoque reservado); so a cobranca falhou. Reenviar
    // com a MESMA checkoutKey cai no curto-circuito de idempotencia.
    const message =
      err instanceof AsaasError
        ? `Não foi possível gerar a cobrança: ${err.message}`
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
 * cobranca Asaas ja criada (re-deriva so o QR/fatura); se ainda nao ha cobranca
 * vinculada (1a tentativa falhou antes do setOrderAsaasRefs), tenta cria-la uma vez.
 */
async function resultForExistingOrder(order: Order): Promise<CheckoutResult> {
  if (!isAsaasConfigured()) {
    return { ok: true, orderId: order.id, pix: null, invoiceUrl: null };
  }

  // Metodo do pedido ja gravado: decide se re-derivamos o QR (pix) ou a fatura (card).
  const method = normalizePaymentMethod(order.paymentMethod);
  const externalReference = order.id.replace(/^#/, "");
  const refs = await getOrderAsaasRefs(Number(externalReference));

  if (refs?.paymentId) {
    if (method === "card") {
      const invoiceUrl = await fetchInvoiceUrl(refs.paymentId);
      return { ok: true, orderId: order.id, pix: null, invoiceUrl };
    }
    const pix = await fetchPix(refs.paymentId);
    return { ok: true, orderId: order.id, pix, invoiceUrl: null };
  }

  try {
    const customer = await createCustomer({
      name: order.customerName,
      email: order.customerEmail,
      mobilePhone: onlyDigits(order.customerPhone),
    });
    const payment = await createCharge({
      customerId: customer.id,
      billingType: paymentBillingType(method),
      valueCents: order.totalCents,
      externalReference,
      dueDate: dueDateStr(dueDateForMethod(method)),
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
    if (method === "card") {
      return { ok: true, orderId: order.id, pix: null, invoiceUrl: payment.invoiceUrl };
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
        ? `Não foi possível gerar a cobrança: ${err.message}`
        : "Não foi possível gerar a cobrança. Tente novamente.";
    return { ok: false, error: message };
  }
}

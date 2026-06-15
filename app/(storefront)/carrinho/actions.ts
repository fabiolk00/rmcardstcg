"use server";

import { auth } from "@clerk/nextjs/server";

import { cartTotals, type CartLine } from "@/lib/cart/totals";
import { createOrder } from "@/lib/data/orders";
import { finalPriceCents } from "@/lib/data/pricing";
import { getProductById } from "@/lib/data/products";
import type { OrderItem } from "@/lib/data/types";
import { AsaasError } from "@/lib/services/asaas/client";
import { isAsaasConfigured } from "@/lib/services/asaas/config";
import { createCustomer, createPixCharge, getPixQrCode } from "@/lib/services/asaas/payments";
import { isClerkConfigured } from "@/lib/services/clerk/config";

/**
 * Server action de checkout — cria o pedido (pending) e a cobranca PIX no Asaas.
 *
 * O elo com o webhook (app/api/webhooks/asaas) e o externalReference: criamos o
 * pedido primeiro para ter o id sequencial e o passamos como externalReference na
 * cobranca. Quando o Asaas confirma o pagamento, o webhook acha o pedido por esse
 * id e marca como "paid".
 *
 * Mock-first: sem chave do Asaas o pedido e criado mesmo assim (pix: null), para
 * o fluxo nao travar em dev. Precos e totais sao SEMPRE recalculados no servidor
 * a partir do banco — nunca confiamos nos valores vindos do cliente.
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
  customer: CheckoutCustomer;
  items: { productId: string; quantity: number }[];
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

/** Vencimento da cobranca PIX (hoje + N dias) no formato YYYY-MM-DD. */
function pixDueDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + PIX_DUE_DAYS);
  return d.toISOString().slice(0, 10);
}

export async function checkout(input: CheckoutInput): Promise<CheckoutResult> {
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

  // Revalida cada item no banco: existe, ativo e com estoque. Monta os snapshots
  // (nome + preco unitario) e as linhas para o calculo de totais.
  const orderItems: OrderItem[] = [];
  const lines: CartLine[] = [];
  for (const { productId, quantity } of input.items) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { ok: false, error: "Quantidade inválida no carrinho." };
    }
    const product = await getProductById(productId);
    if (!product || !product.isActive) {
      return { ok: false, error: "Um dos produtos não está mais disponível." };
    }
    if (product.stock < quantity) {
      return { ok: false, error: `Estoque insuficiente para "${product.name}".` };
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

  // Cria o pedido pendente — gera o id que vira o externalReference.
  const order = await createOrder({
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
    shippingCents: totals.shippingCents,
    totalCents: totals.totalCents,
    paymentMethod: "PIX",
  });

  // Sem Asaas configurado (dev sem chave): pedido criado, sem cobranca.
  if (!isAsaasConfigured()) {
    return { ok: true, orderId: order.id, pix: null, invoiceUrl: null };
  }

  // externalReference precisa do id numerico (o dominio expoe "#10421").
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
      valueCents: totals.totalCents,
      externalReference,
      dueDate: pixDueDate(),
      description: `Pedido ${order.id} — RM Cards`,
    });

    // O QR exige uma chave PIX cadastrada na conta Asaas. Se ainda nao houver,
    // a cobranca existe e e pagavel pela invoiceUrl — degrada sem travar o pedido.
    let pix: CheckoutPix | null = null;
    try {
      const qr = await getPixQrCode(payment.id);
      pix = {
        payload: qr.payload,
        encodedImage: qr.encodedImage,
        expirationDate: qr.expirationDate,
      };
    } catch (qrErr) {
      console.warn(
        "[checkout] QR PIX indisponivel (cadastre uma chave PIX no Asaas):",
        qrErr instanceof Error ? qrErr.message : qrErr,
      );
    }

    return { ok: true, orderId: order.id, pix, invoiceUrl: payment.invoiceUrl };
  } catch (err) {
    // O pedido ja existe (pending); so a cobranca falhou. O cliente pode tentar
    // pagar de novo pela fatura mais tarde, entao nao apagamos o pedido.
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

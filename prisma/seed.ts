// Seed do banco a partir de prisma/seed-data.ts (dados iniciais).
// Roda standalone via `pnpm db:seed` (tsx). Idempotente: pode rodar de novo.
import "dotenv/config";

import { prisma } from "../lib/db";
import { SEED_ORDERS, SEED_PRODUCTS } from "./seed-data";

async function main() {
  const products = SEED_PRODUCTS;
  const orders = SEED_ORDERS;

  // Pedidos primeiro (itens caem por cascade) para reseed limpo.
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();

  // Produtos: upsert por sku (unico). Guarda o mapa id-mock -> uuid do banco
  // para reescrever as FKs dos itens de pedido.
  const dbIdByMockId = new Map<string, string>();
  for (const p of products) {
    const data = {
      slug: p.slug,
      name: p.name,
      category: p.category,
      priceCents: p.priceCents,
      discountPct: p.discountPct,
      rating: p.rating,
      reviewCount: p.reviewCount,
      stock: p.stock,
      isActive: p.isActive,
      isCarousel: p.isCarousel,
      badge: p.badge,
      imageUrl: p.imageUrl,
      description: p.description,
      createdAt: new Date(p.createdAt),
    };
    const row = await prisma.product.upsert({
      where: { sku: p.sku },
      update: data,
      create: { ...data, sku: p.sku },
    });
    dbIdByMockId.set(p.id, row.id);
  }

  // Pedidos + itens (endereco achatado; productId mock -> uuid).
  for (const o of orders) {
    await prisma.order.create({
      data: {
        userId: o.userId,
        customerName: o.customerName,
        customerEmail: o.customerEmail,
        customerPhone: o.customerPhone,
        addressCep: o.address.cep,
        addressStreet: o.address.street,
        addressCity: o.address.city,
        addressState: o.address.state,
        subtotalCents: o.subtotalCents,
        discountCents: o.discountCents,
        shippingCents: o.shippingCents,
        totalCents: o.totalCents,
        shippingService: o.shippingService,
        shippingDays: o.shippingDays,
        paymentStatus: o.paymentStatus,
        paymentMethod: o.paymentMethod,
        shippingStatus: o.shippingStatus,
        internalNote: o.internalNote,
        createdAt: new Date(o.createdAt),
        items: {
          create: o.items.map((it) => {
            const productId = dbIdByMockId.get(it.productId);
            if (!productId) {
              throw new Error(`Pedido ${o.id}: produto mock ${it.productId} nao existe no seed.`);
            }
            return {
              productId,
              productName: it.productName,
              quantity: it.quantity,
              unitPriceCents: it.unitPriceCents,
            };
          }),
        },
      },
    });
  }

  console.log(`Seed OK: ${products.length} produtos, ${orders.length} pedidos inseridos.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

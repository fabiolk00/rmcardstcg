import { prisma } from "../db";
import type { ProductModel } from "../generated/prisma/models";
import type { Category, Product } from "./types";

/**
 * Camada de dados de produtos — Postgres via Prisma (lib/db).
 *
 * Esta e a fronteira DB <-> dominio: mapeia o registro do banco para o contrato
 * Product (lib/data/types.ts). As telas consomem so estas funcoes e nao sabem
 * que a origem virou Postgres (antes era mock).
 * - rating (Decimal) -> number; createdAt (Date) -> ISO string;
 * - category e String no banco, com os valores exatos do contrato.
 */
function toProduct(row: ProductModel): Product {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category as Category,
    sku: row.sku,
    priceCents: row.priceCents,
    discountPct: row.discountPct,
    rating: Number(row.rating),
    reviewCount: row.reviewCount,
    stock: row.stock,
    isActive: row.isActive,
    badge: row.badge,
    imageUrl: row.imageUrl,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Todos os produtos (ativos e inativos), mais recentes primeiro. */
export async function getProducts(): Promise<Product[]> {
  const rows = await prisma.product.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(toProduct);
}

/** Apenas produtos ativos (vitrine). */
export async function getActiveProducts(): Promise<Product[]> {
  const rows = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toProduct);
}

/** Produto por slug (URL/deep-link); null se nao existir. */
export async function getProductBySlug(slug: string): Promise<Product | null> {
  const row = await prisma.product.findUnique({ where: { slug } });
  return row ? toProduct(row) : null;
}

/** Produto por id; null se nao existir. */
export async function getProductById(id: string): Promise<Product | null> {
  const row = await prisma.product.findUnique({ where: { id } });
  return row ? toProduct(row) : null;
}

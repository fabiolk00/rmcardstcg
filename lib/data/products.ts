import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import type { ProductModel } from "../generated/prisma/models";
import { writeAuditLog, type AuditActor } from "./audit";
import { CATEGORIES } from "./types";
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
    isCarousel: row.isCarousel,
    badge: row.badge,
    imageUrl: row.imageUrl,
    description: row.description,
    weightGrams: row.weightGrams,
    lengthCm: row.lengthCm,
    widthCm: row.widthCm,
    heightCm: row.heightCm,
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

/**
 * Produtos por uma lista de ids, em UMA query (evita N+1 no checkout, que antes
 * fazia um findUnique por item do carrinho). A ordem do retorno nao e garantida;
 * o chamador indexa por id.
 */
export async function getProductsByIds(ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.product.findMany({ where: { id: { in: ids } } });
  return rows.map(toProduct);
}

// ===========================================================================
// CRUD persistido de produto (admin). Cada mutacao roda numa transacao Prisma
// com writeAuditLog na MESMA transacao (invariante 3). O SERVIDOR e a fonte de
// verdade: validacao e slug sao recalculados aqui, nunca confiados ao cliente.
// ===========================================================================

// Marcas combinantes (acentos) U+0300-U+036F — espelha o slugify da UI.
const COMBINING = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(COMBINING, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Erro de validacao de dominio — vira mensagem amigavel na server action. */
export class ProductValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductValidationError";
  }
}

/** Campos editaveis de um produto (sem id/derivados). O servidor deriva o slug. */
export type ProductInput = {
  name: string;
  category: string;
  sku: string;
  priceCents: number;
  discountPct: number;
  stock: number;
  badge: string | null;
  imageUrl: string;
  description: string;
  /** Exibir no carrossel "Em destaque" da landing. */
  isCarousel: boolean;
  /** Medidas do pacote para frete (Int; 0 = usa o default da categoria). */
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

type NormalizedProductInput = {
  name: string;
  category: Category;
  sku: string;
  priceCents: number;
  discountPct: number;
  stock: number;
  badge: string | null;
  imageUrl: string;
  description: string;
  isCarousel: boolean;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

const DESC_MAX = 300;

/**
 * Valida e normaliza um ProductInput. Faixas, categoria, inteiros de centavos,
 * trims. Lanca ProductValidationError (pt-BR) em caso de violacao.
 */
function normalizeProductInput(input: ProductInput): NormalizedProductInput {
  const name = input.name?.trim() ?? "";
  if (name === "") throw new ProductValidationError("O nome do produto é obrigatório.");

  const sku = input.sku?.trim() ?? "";
  if (sku === "") throw new ProductValidationError("O SKU é obrigatório.");

  if (!CATEGORIES.includes(input.category as Category)) {
    throw new ProductValidationError("Categoria inválida.");
  }
  const category = input.category as Category;

  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new ProductValidationError("Preço inválido (deve ser inteiro de centavos >= 0).");
  }
  if (!Number.isInteger(input.discountPct) || input.discountPct < 0 || input.discountPct > 80) {
    throw new ProductValidationError("Desconto inválido (0 a 80%).");
  }
  if (!Number.isInteger(input.stock) || input.stock < 0) {
    throw new ProductValidationError("Estoque inválido (inteiro >= 0).");
  }

  const description = input.description?.trim() ?? "";
  if (description.length > DESC_MAX) {
    throw new ProductValidationError(`A descrição excede ${DESC_MAX} caracteres.`);
  }

  const badge = input.badge?.trim() ? input.badge.trim() : null;
  const imageUrl = input.imageUrl?.trim() ? input.imageUrl.trim() : "/products/placeholder.svg";
  // Checkbox: forca booleano (undefined/null/"" do client viram false).
  const isCarousel = input.isCarousel === true;
  // Medidas para frete (grama/cm, Int >= 0). Invalido/ausente -> 0, que faz a cotacao
  // usar o default da categoria. Sem teto rigido (variam por produto).
  const dim = (v: unknown): number =>
    Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0;

  return {
    name,
    category,
    sku,
    priceCents: input.priceCents,
    discountPct: input.discountPct,
    stock: input.stock,
    badge,
    imageUrl,
    description,
    isCarousel,
    weightGrams: dim(input.weightGrams),
    lengthCm: dim(input.lengthCm),
    widthCm: dim(input.widthCm),
    heightCm: dim(input.heightCm),
  };
}

/** Snapshot do dominio para before/after do audit_log (camelCase, *Cents int). */
function auditSnapshot(p: Product): Prisma.InputJsonValue {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category,
    sku: p.sku,
    priceCents: p.priceCents,
    discountPct: p.discountPct,
    stock: p.stock,
    isActive: p.isActive,
    isCarousel: p.isCarousel,
    badge: p.badge,
    imageUrl: p.imageUrl,
    description: p.description,
    weightGrams: p.weightGrams,
    lengthCm: p.lengthCm,
    widthCm: p.widthCm,
    heightCm: p.heightCm,
  };
}

/**
 * Deriva um slug unico a partir do nome (anexa -2, -3, ... se colidir). Usa o
 * `tx` para enxergar inserts da mesma transacao. excludeId ignora o proprio
 * produto (update sem trocar o nome).
 */
async function uniqueSlug(
  tx: Prisma.TransactionClient,
  name: string,
  excludeId?: string,
): Promise<string> {
  const base = slugify(name) || "produto";
  // Uma unica query (evita N+1: antes era um findUnique por colisao). Pega os
  // slugs ja usados na familia base / base-N e escolhe o menor sufixo livre.
  const rows = await tx.product.findMany({
    where: {
      OR: [{ slug: base }, { slug: { startsWith: `${base}-` } }],
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { slug: true },
  });
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Improvavel (1000 colisoes do mesmo nome): sufixo aleatorio garante unicidade.
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Cria um produto. Valida no server, garante slug/sku unicos e grava audit_log
 * na MESMA transacao (invariante 3). SKU duplicado falha em ProductValidationError.
 */
export async function createProduct(actor: AuditActor, input: ProductInput): Promise<Product> {
  const data = normalizeProductInput(input);

  return prisma.$transaction(async (tx) => {
    const skuClash = await tx.product.findFirst({
      where: { sku: { equals: data.sku, mode: "insensitive" } },
      select: { id: true },
    });
    if (skuClash) throw new ProductValidationError(`Já existe um produto com o SKU "${data.sku}".`);

    const slug = await uniqueSlug(tx, data.name);

    const row = await tx.product.create({
      data: {
        slug,
        name: data.name,
        category: data.category,
        sku: data.sku,
        priceCents: data.priceCents,
        discountPct: data.discountPct,
        stock: data.stock,
        isActive: true,
        isCarousel: data.isCarousel,
        badge: data.badge,
        imageUrl: data.imageUrl,
        description: data.description,
        weightGrams: data.weightGrams,
        lengthCm: data.lengthCm,
        widthCm: data.widthCm,
        heightCm: data.heightCm,
      },
    });
    const product = toProduct(row);

    await writeAuditLog(tx, {
      actor,
      action: AuditAction.product_create,
      entityType: AuditEntityType.product,
      entityId: product.id,
      before: null,
      after: auditSnapshot(product),
    });

    return product;
  });
}

/**
 * Atualiza um produto. Recalcula slug se o nome mudou (mantendo unicidade),
 * valida SKU unico, e grava audit_log (before/after) na MESMA transacao.
 */
export async function updateProduct(
  actor: AuditActor,
  id: string,
  input: ProductInput,
): Promise<Product> {
  const data = normalizeProductInput(input);

  return prisma.$transaction(async (tx) => {
    // (1) BASELINE: le a linha que o editor TINHA ao montar o formulario (o snapshot
    // de onde ele partiu). Sob READ COMMITTED, duas edicoes concorrentes que abrem o
    // form ao mesmo tempo leem o MESMO baseline. E contra ESTE baseline — nao contra o
    // estado mais recente — que decidimos quais campos o editor de fato pretendeu
    // mudar (diff de intencao). Um campo cujo valor enviado == baseline e um campo que
    // o editor NAO tocou (so carregou o valor do form), e nao deve ser reescrito.
    const baseline = await tx.product.findUnique({ where: { id } });
    if (!baseline) throw new ProductValidationError("Produto não encontrado.");
    const before = toProduct(baseline);

    // (2) DIFF DE INTENCAO contra o baseline: monta o conjunto de campos que ESTE
    // editor realmente alterou. Campos iguais ao baseline ficam de fora do UPDATE.
    // Editores concorrentes que mudam campos DISJUNTOS (ex.: um so stock, outro so
    // discountPct) gravam colunas disjuntas e nao se sobrescrevem — fim do lost
    // update por write da linha inteira com snapshot stale. O slug e derivado do
    // nome: so muda quando o nome mudou.
    const slug = await uniqueSlug(tx, data.name, id);
    const updateData: Prisma.ProductUpdateInput = {};
    if (data.name !== baseline.name) {
      updateData.name = data.name;
      if (slug !== baseline.slug) updateData.slug = slug;
    }
    if (data.category !== baseline.category) updateData.category = data.category;
    if (data.sku !== baseline.sku) updateData.sku = data.sku;
    if (data.priceCents !== baseline.priceCents) updateData.priceCents = data.priceCents;
    if (data.discountPct !== baseline.discountPct) updateData.discountPct = data.discountPct;
    if (data.stock !== baseline.stock) updateData.stock = data.stock;
    if (data.isCarousel !== baseline.isCarousel) updateData.isCarousel = data.isCarousel;
    if (data.badge !== baseline.badge) updateData.badge = data.badge;
    if (data.imageUrl !== baseline.imageUrl) updateData.imageUrl = data.imageUrl;
    if (data.description !== baseline.description) updateData.description = data.description;
    if (data.weightGrams !== baseline.weightGrams) updateData.weightGrams = data.weightGrams;
    if (data.lengthCm !== baseline.lengthCm) updateData.lengthCm = data.lengthCm;
    if (data.widthCm !== baseline.widthCm) updateData.widthCm = data.widthCm;
    if (data.heightCm !== baseline.heightCm) updateData.heightCm = data.heightCm;

    // (3) SERIALIZA a aplicacao: trava a LINHA com SELECT ... FOR UPDATE. Edicoes
    // concorrentes do MESMO produto serializam aqui — a 2a transacao BLOQUEIA ate a
    // 1a commitar. Apos o lock, re-le o estado FRESCO (que ja inclui o commit da
    // edicao anterior). Isso garante: validacao de reserved contra a verdade atual E
    // um `after` coerente (a ultima a commitar enxerga a mutacao da primeira).
    const lockedRows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "products" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (lockedRows.length === 0) throw new ProductValidationError("Produto não encontrado.");

    const fresh = await tx.product.findUnique({ where: { id } });
    if (!fresh) throw new ProductValidationError("Produto não encontrado.");

    // O estoque novo (se este editor o mudou) nunca pode ficar abaixo das unidades ja
    // reservadas em pedidos pendentes (rede final tambem no CHECK reserved<=stock).
    // Mensagem clara em pt-BR, validada contra o `reserved` FRESCO sob o lock.
    if (updateData.stock !== undefined && data.stock < fresh.reserved) {
      throw new ProductValidationError(
        `Não é possível definir o estoque (${data.stock}) abaixo das ${fresh.reserved} unidade(s) reservada(s) em pedidos pendentes.`,
      );
    }

    // SKU unico (se este editor mudou o sku): checa contra o estado FRESCO.
    if (updateData.sku !== undefined) {
      const skuClash = await tx.product.findFirst({
        where: { sku: { equals: data.sku, mode: "insensitive" }, id: { not: id } },
        select: { id: true },
      });
      if (skuClash) {
        throw new ProductValidationError(`Já existe um produto com o SKU "${data.sku}".`);
      }
    }

    const row = await tx.product.update({ where: { id }, data: updateData });
    const product = toProduct(row);

    await writeAuditLog(tx, {
      actor,
      action: AuditAction.product_update,
      entityType: AuditEntityType.product,
      entityId: product.id,
      before: auditSnapshot(before),
      after: auditSnapshot(product),
    });

    return product;
  });
}

/**
 * Inativa (false) ou reativa (true) um produto. Idempotente: se ja estiver no
 * estado pedido, no-op (nao grava audit ruidoso). Audita product_inactivate /
 * product_reactivate na MESMA transacao.
 *
 * "Excluir" e deliberadamente NAO implementado neste ciclo: a UI so oferece
 * inativar/reativar, e OrderItem guarda snapshot com FK Restrict — hard-delete
 * de produto vendido quebraria o historico. Inativar e o soft-delete efetivo.
 */
export async function setProductActive(
  actor: AuditActor,
  id: string,
  isActive: boolean,
): Promise<Product> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id } });
    if (!current) throw new ProductValidationError("Produto não encontrado.");
    const before = toProduct(current);

    if (before.isActive === isActive) return before; // no-op idempotente

    const row = await tx.product.update({ where: { id }, data: { isActive } });
    const product = toProduct(row);

    await writeAuditLog(tx, {
      actor,
      action: isActive ? AuditAction.product_reactivate : AuditAction.product_inactivate,
      entityType: AuditEntityType.product,
      entityId: product.id,
      before: auditSnapshot(before),
      after: auditSnapshot(product),
    });

    return product;
  });
}

import { prisma } from "../db";
import { Prisma } from "../generated/prisma/client";
import { AuditAction, AuditEntityType } from "../generated/prisma/enums";
import type { ProductModel } from "../generated/prisma/models";
import { cleanupReplacedImage } from "../services/supabase/orphans";
import { writeAuditLog, type AuditActor } from "./audit";
import { categoryExists } from "./categories";
import { RELATED_LIMIT, selectRelatedProducts } from "./related";
import type { Product } from "./types";

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
    category: row.category,
    sku: row.sku,
    priceCents: row.priceCents,
    discountPct: row.discountPct,
    rating: Number(row.rating),
    reviewCount: row.reviewCount,
    stock: row.stock,
    available: Math.max(0, row.stock - row.reserved),
    isActive: row.isActive,
    isLanding: row.isLanding,
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

/**
 * Produtos relacionados ao informado (pagina de produto) — UMA query: ativos da
 * MESMA categoria (indice @@index([category])), exceto o proprio. Traz uma janela
 * pequena e a selecao pura (selectRelatedProducts) ordena/limita (em-estoque
 * primeiro). Sem N+1: nunca consulta produto a produto.
 */
export async function getRelatedProducts(
  product: Pick<Product, "id" | "category">,
  limit = RELATED_LIMIT,
): Promise<Product[]> {
  const rows = await prisma.product.findMany({
    where: { isActive: true, category: product.category, id: { not: product.id } },
    orderBy: { createdAt: "desc" },
    take: limit * 4,
  });
  return selectRelatedProducts(rows.map(toProduct), product, limit);
}

/**
 * Produto com estoque baixo (visao de admin). `reserved` nao faz parte do
 * contrato Product (lib/data/types.ts) — vive so no registro do banco —, entao
 * expomos um shape dedicado com o derivado `available = stock - reserved`.
 */
export type LowStockProduct = {
  id: string;
  name: string;
  stock: number;
  reserved: number;
  /** Derivado: estoque disponivel (stock - reserved). */
  available: number;
};

/** Limite padrao de "estoque baixo" (espelha o selo "baixo" da lista de produtos). */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Produtos com estoque disponivel (stock - reserved) <= threshold, do menor
 * disponivel para o maior (mais critico primeiro). So leitura: nao toca em
 * reserva/estoque (ver lib/data/inventory.ts para mutacoes). O filtro roda no
 * banco via raw query porque `available` e derivado de duas colunas.
 */
export async function getLowStockProducts(
  threshold = LOW_STOCK_THRESHOLD,
): Promise<LowStockProduct[]> {
  const rows = await prisma.$queryRaw<
    { id: string; name: string; stock: number; reserved: number }[]
  >`
    SELECT "id", "name", "stock", "reserved"
    FROM "products"
    WHERE ("stock" - "reserved") <= ${threshold}
    ORDER BY ("stock" - "reserved") ASC, "name" ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    stock: r.stock,
    reserved: r.reserved,
    available: r.stock - r.reserved,
  }));
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
  isLanding: boolean;
  /** Medidas do pacote para frete (Int; 0 = usa o default da categoria). */
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

type NormalizedProductInput = {
  name: string;
  category: string;
  sku: string;
  priceCents: number;
  discountPct: number;
  stock: number;
  badge: string | null;
  imageUrl: string;
  description: string;
  isLanding: boolean;
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

  // Forma (nao-vazia) aqui; a EXISTENCIA na tabela `categories` (acoplamento por
  // nome) e checada no server dentro da transacao — ver categoryExists no create/update.
  const category = input.category?.trim() ?? "";
  if (category === "") throw new ProductValidationError("A categoria é obrigatória.");

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
  const isLanding = input.isLanding === true;
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
    isLanding,
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
    isLanding: p.isLanding,
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
    // Acoplamento por nome: a categoria precisa existir na tabela `categories`.
    if (!(await categoryExists(data.category, tx))) {
      throw new ProductValidationError(`Categoria "${data.category}" não existe.`);
    }

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
        isLanding: data.isLanding,
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
  // Snapshot dos campos editaveis que o EDITOR carregou no formulario (client
  // baseline). Quando fornecido, o diff de intencao compara o input contra ESTE
  // snapshot — nao contra um read fresco do servidor —, garantindo que um campo que o
  // editor NAO tocou (input == original) fique fora do UPDATE mesmo que outro admin o
  // tenha mudado nesse meio tempo. Ausente -> diff contra o baseline do servidor (legado).
  original?: ProductInput,
): Promise<Product> {
  const data = normalizeProductInput(input);
  // Normaliza o original como o input, p/ o diff comparar like-for-like (mesmos
  // trims/coercoes). Ausente -> null (cai no baseline do servidor abaixo).
  const orig = original ? normalizeProductInput(original) : null;

  const result = await prisma.$transaction(async (tx) => {
    // (1) BASELINE DO SERVIDOR: a linha atual. Serve p/ o `before` da auditoria e a
    // checagem de existencia. NAO e (mais) a referencia do diff de intencao: sob READ
    // COMMITTED, duas edicoes que NAO se sobrepoem no tempo leriam baselines diferentes
    // (a 2a ja enxerga o commit da 1a), e o campo intocado da 2a seria reescrito com o
    // valor stale do seu form (lost update). Por isso o diff compara contra o que o
    // EDITOR carregou (orig, client baseline) quando disponivel.
    const baseline = await tx.product.findUnique({ where: { id } });
    if (!baseline) throw new ProductValidationError("Produto não encontrado.");
    const before = toProduct(baseline);

    // Referencia do DIFF DE INTENCAO: o snapshot que o editor carregou (orig), quando
    // fornecido; senao a linha do servidor (legado). Tipada como NormalizedProductInput
    // p/ comparar like-for-like com `data` sem atrito de tipos (ProductModel vs input).
    const cmp: NormalizedProductInput = orig ?? {
      name: baseline.name,
      category: baseline.category,
      sku: baseline.sku,
      priceCents: baseline.priceCents,
      discountPct: baseline.discountPct,
      stock: baseline.stock,
      badge: baseline.badge,
      imageUrl: baseline.imageUrl,
      description: baseline.description,
      isLanding: baseline.isLanding,
      weightGrams: baseline.weightGrams,
      lengthCm: baseline.lengthCm,
      widthCm: baseline.widthCm,
      heightCm: baseline.heightCm,
    };

    // (2) DIFF DE INTENCAO contra `cmp`: o conjunto de campos que ESTE editor realmente
    // alterou (input != o que ele carregou). Campos iguais ficam de fora do UPDATE.
    // Editores concorrentes que mudam campos DISJUNTOS (ex.: um so stock, outro so
    // discountPct) gravam colunas disjuntas e nao se sobrescrevem — fim do lost update,
    // agora DETERMINISTICO (independe de as 2 transacoes se sobreporem no tempo). O slug
    // e derivado do nome e comparado contra o baseline do servidor (so muda com o nome).
    const slug = await uniqueSlug(tx, data.name, id);
    const updateData: Prisma.ProductUpdateInput = {};
    if (data.name !== cmp.name) {
      updateData.name = data.name;
      if (slug !== baseline.slug) updateData.slug = slug;
    }
    if (data.category !== cmp.category) updateData.category = data.category;
    if (data.sku !== cmp.sku) updateData.sku = data.sku;
    if (data.priceCents !== cmp.priceCents) updateData.priceCents = data.priceCents;
    if (data.discountPct !== cmp.discountPct) updateData.discountPct = data.discountPct;
    if (data.stock !== cmp.stock) updateData.stock = data.stock;
    if (data.isLanding !== cmp.isLanding) updateData.isLanding = data.isLanding;
    if (data.badge !== cmp.badge) updateData.badge = data.badge;
    if (data.imageUrl !== cmp.imageUrl) updateData.imageUrl = data.imageUrl;
    if (data.description !== cmp.description) updateData.description = data.description;
    if (data.weightGrams !== cmp.weightGrams) updateData.weightGrams = data.weightGrams;
    if (data.lengthCm !== cmp.lengthCm) updateData.lengthCm = data.lengthCm;
    if (data.widthCm !== cmp.widthCm) updateData.widthCm = data.widthCm;
    if (data.heightCm !== cmp.heightCm) updateData.heightCm = data.heightCm;

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

    // Categoria (se este editor a mudou): precisa existir na tabela `categories`.
    if (updateData.category !== undefined && !(await categoryExists(data.category, tx))) {
      throw new ProductValidationError(`Categoria "${data.category}" não existe.`);
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

    // A troca de imagem (old -> new) já fica registrada no audit acima (imageUrl no
    // before/after). Sinalizamos a URL antiga p/ o cleanup PÓS-COMMIT abaixo.
    const replacedImageUrl = before.imageUrl !== product.imageUrl ? before.imageUrl : null;
    return { product, replacedImageUrl };
  });

  // PÓS-COMMIT (fora da transação — o Storage não é transacional com o Postgres):
  // remove o objeto antigo do bucket quando a imagem mudou. Best-effort e nunca lança;
  // uma falha aqui deixa um órfão que o reconcile varre depois — jamais corrompe o save.
  if (result.replacedImageUrl) {
    await cleanupReplacedImage(result.replacedImageUrl);
  }
  return result.product;
}

/**
 * Inativa (false) ou reativa (true) um produto. Idempotente: se ja estiver no
 * estado pedido, no-op (nao grava audit ruidoso). Audita product_inactivate /
 * product_reactivate na MESMA transacao.
 *
 * Inativar e o soft-delete reversivel (tira da loja, preserva historico). A
 * exclusao PERMANENTE (deleteProduct, abaixo) e um caminho separado, BLOQUEADO
 * para produto ja vendido — OrderItem guarda snapshot com FK Restrict e hard-delete
 * quebraria o historico. Produto vendido deve ser inativado, nao excluido.
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

export type ProductDeleteResult = { ok: true; id: string } | { ok: false; error: string };

/** Mensagem unica para "ja vendido": NUNCA exclui produto com historico de pedido. */
const PRODUCT_IN_USE =
  "Produto já foi vendido e não pode ser excluído. Inative-o para tirá-lo da loja." as const;

/**
 * Detecta violacao de FK por RESTRICT no delete de produto (um order_item referencia
 * o produto), reconhecendo os DOIS shapes do Prisma 7 — GEMEO de isForeignKeyViolation
 * em lib/data/coupons.ts (mesma migracao de shape do adapter-pg). Mantido local (as
 * duas guardas de dominio sao independentes) em vez de compartilhado:
 *  - compat (Prisma <=6): PrismaClientKnownRequestError com code "P2003".
 *  - Prisma 7 + @prisma/adapter-pg: a violacao chega como `DriverAdapterError` CRU,
 *    cujo `.cause` carrega o erro do driver pg ({ code/originalCode }) — 23001
 *    (restrict_violation, o caso da FK OrderItem.product = Restrict por default) ou
 *    23503 (foreign_key_violation). Nesse shape NAO ha `.code` no topo nem `instanceof
 *    PrismaClientKnownRequestError`. Opcionalmente casa o nome da constraint para so
 *    tratar a FK esperada (order_items -> products) como "em uso".
 */
function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  const hit = (value: unknown): boolean =>
    constraint === undefined || String(value ?? "").includes(constraint);

  // Compat: PrismaClientKnownRequestError P2003 (Prisma <=6 / engine que mapeia).
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code !== "P2003") return false;
    if (constraint === undefined) return true;
    return hit((err.meta as { target?: unknown } | undefined)?.target) || hit(err.message);
  }

  // Prisma 7 (driver adapter): DriverAdapterError cru com .cause do pg (23001/23503).
  const e = err as {
    message?: string;
    cause?: { code?: string; originalCode?: string; message?: string; detail?: string };
  };
  const pgCode = e?.cause?.code ?? e?.cause?.originalCode;
  if (pgCode !== "23001" && pgCode !== "23503") return false;
  if (constraint === undefined) return true;
  return hit(e.cause?.message) || hit(e.cause?.detail) || hit(e.message);
}

/**
 * Exclui um produto PERMANENTEMENTE (o "D" do CRUD). Diferente de setProductActive
 * (inativacao reversivel), o registro deixa de existir.
 *
 * Guarda de integridade: so exclui se o produto NUNCA foi vendido. OrderItem guarda o
 * snapshot da compra (nome/preco no momento) com FK onDelete: Restrict (default do
 * Prisma p/ relacao obrigatoria) — apagar um produto vendido destruiria o historico de
 * pedidos. Produto ja vendido deve ser INATIVADO, nao excluido. Avaliacoes (Review) tem
 * FK onDelete: Cascade e somem junto com o produto (sao denormalizadas em rating/
 * reviewCount, que morrem com a linha).
 *
 * A contagem de order_items e o delete correm na MESMA transacao (SELECT count + DELETE
 * serializados), fechando a corrida "conta 0, pedido novo entra, deleta"; um order_item
 * inserido nesse meio dispara a FK Restrict (pg 23001 / P2003), tratada como "em uso" via
 * isForeignKeyViolation. Grava audit_log (product_delete, before=snapshot, after=null) na
 * MESMA transacao (invariante 3). Pos-commit, remove a imagem orfa do bucket (best-effort,
 * mesmo helper do updateProduct — o Storage nao e transacional com o Postgres).
 */
export async function deleteProduct(actor: AuditActor, id: string): Promise<ProductDeleteResult> {
  let outcome: { kind: "not_found" } | { kind: "in_use" } | { kind: "ok"; imageUrl: string };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id } });
      if (!existing) return { kind: "not_found" as const };

      const soldUnits = await tx.orderItem.count({ where: { productId: id } });
      if (soldUnits > 0) return { kind: "in_use" as const };

      const before = toProduct(existing);
      await tx.product.delete({ where: { id } }); // reviews caem por cascade (onDelete: Cascade)
      await writeAuditLog(tx, {
        actor,
        action: AuditAction.product_delete,
        entityType: AuditEntityType.product,
        entityId: id,
        before: auditSnapshot(before),
        after: null,
      });
      return { kind: "ok" as const, imageUrl: before.imageUrl };
    });
  } catch (err) {
    // Corrida: order_item gravado entre a contagem e o delete -> FK Restrict. Sob Prisma 7
    // + adapter-pg isso chega como DriverAdapterError cru (pg 23001 restrict_violation),
    // NAO como PrismaClientKnownRequestError P2003 — por isso reconhecemos ambos os shapes.
    if (isForeignKeyViolation(err, "order_items_product_id_fkey")) {
      return { ok: false, error: PRODUCT_IN_USE };
    }
    throw err;
  }

  if (outcome.kind === "not_found") return { ok: false, error: "Produto não encontrado." };
  if (outcome.kind === "in_use") return { ok: false, error: PRODUCT_IN_USE };

  // PÓS-COMMIT (fora da transação — o Storage não é transacional com o Postgres): remove
  // o objeto do bucket agora que nenhum produto o referencia. Best-effort e nunca lança;
  // uma falha aqui deixa um órfão que o reconcile varre depois — jamais quebra o delete.
  await cleanupReplacedImage(outcome.imageUrl);
  return { ok: true, id };
}

/**
 * Contratos de dados (shape da API) — fronteira mock <-> Supabase.
 *
 * Convencoes (secao 4 do contrato):
 * - Dinheiro sempre em inteiro de centavos (sufixo *Cents). Nunca float.
 * - Dominio em camelCase; a camada lib/db (F10) mapeia colunas snake_case do
 *   Postgres para estes tipos, sem tocar nas telas.
 * - Preco final e DERIVADO (finalPriceCents), nunca salvo.
 */

export type Category =
  | "Booster Box"
  | "Elite Trainer Box"
  | "Booster Pack"
  | "Blister Triplo"
  | "Blister Quadruplo"
  | "Coleção Especial"
  | "Tin"
  | "Acessórios"
  | "Single Card";

export const CATEGORIES: readonly Category[] = [
  "Booster Box",
  "Elite Trainer Box",
  "Booster Pack",
  "Blister Triplo",
  "Blister Quadruplo",
  "Coleção Especial",
  "Tin",
  "Acessórios",
  "Single Card",
] as const;

export interface Product {
  /** Estavel no mock; uuid no Postgres (F8). */
  id: string;
  /** Unico; usado em URL e deep-link (produto/[slug]). */
  slug: string;
  name: string;
  category: Category;
  /** Unico. */
  sku: string;
  /** Preco base em centavos. */
  priceCents: number;
  /** Desconto percentual (0–80). */
  discountPct: number;
  /** Nota media (0–5, uma casa decimal). */
  rating: number;
  /** Numero de avaliacoes. */
  reviewCount: number;
  /** Estoque atual em unidades. */
  stock: number;
  isActive: boolean;
  /** Exibir no carrossel "Em destaque" da landing (controle do admin). */
  isCarousel: boolean;
  /** Selo opcional (ex.: "Mais vendido", "-20%", "Raro"). */
  badge: string | null;
  /** Caminho da imagem (placeholder no mock). */
  imageUrl: string;
  description: string;
  /** Peso do pacote para frete, em GRAMAS (Int). 0 = usa o default da categoria. */
  weightGrams: number;
  /** Comprimento do pacote para frete, em CM (Int). 0 = default da categoria. */
  lengthCm: number;
  /** Largura do pacote para frete, em CM (Int). 0 = default da categoria. */
  widthCm: number;
  /** Altura do pacote para frete, em CM (Int). 0 = default da categoria. */
  heightCm: number;
  /** ISO 8601. */
  createdAt: string;
}

export type PaymentStatus = "pending" | "paid" | "cancelled";
export type ShippingStatus = "pending" | "sent" | "delivered" | "cancelled";

export type ReviewStatus = "pending" | "approved" | "rejected";

export interface Review {
  id: string;
  productId: string;
  /** Autor (clerk_user_id no DB; "guest" no mock-first). */
  userId: string;
  authorName: string;
  /** Nota inteira 1–5. */
  rating: number;
  title: string | null;
  body: string;
  status: ReviewStatus;
  /** ISO 8601. */
  createdAt: string;
}

/** Agregado das avaliacoes APROVADAS de um produto (ReviewStats). */
export interface ReviewStats {
  count: number;
  /** Media 0–5, uma casa decimal (mesmo formato de Product.rating). */
  average: number;
  /** Contagem por nota (1..5). */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

export interface OrderItem {
  productId: string;
  /** Snapshot do nome no momento da compra. */
  productName: string;
  quantity: number;
  /** Snapshot do preco unitario pago, em centavos. */
  unitPriceCents: number;
}

export interface OrderAddress {
  cep: string;
  street: string;
  city: string;
  state: string;
}

export interface Order {
  /** Numero legivel sequencial (ex.: "#10421"). */
  id: string;
  /** Referencia ao usuario (clerk_user_id no DB). Mock ate F9. */
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** Snapshot do endereco de entrega. */
  address: OrderAddress;
  items: OrderItem[];
  subtotalCents: number;
  /** Desconto de PRODUTO (preco base - preco final por item). */
  discountCents: number;
  /** Codigo do cupom aplicado, se houver. */
  couponCode: string | null;
  /** Desconto de CUPOM (separado do desconto de produto). */
  couponDiscountCents: number;
  shippingCents: number;
  /** total = subtotal - discountCents - couponDiscountCents + frete. */
  totalCents: number;
  shippingService: string | null;
  shippingDays: string | null;
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  shippingStatus: ShippingStatus;
  internalNote: string | null;
  /** ISO 8601. */
  createdAt: string;
}

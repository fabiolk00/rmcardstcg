/**
 * Contratos de dados (shape da API) — fronteira mock <-> Supabase.
 *
 * Convencoes (secao 4 do contrato):
 * - Dinheiro sempre em inteiro de centavos (sufixo *Cents). Nunca float.
 * - Dominio em camelCase; a camada lib/db (F10) mapeia colunas snake_case do
 *   Postgres para estes tipos, sem tocar nas telas.
 * - Preco final e DERIVADO (finalPriceCents), nunca salvo.
 */

/**
 * Conjunto CANONICO de categorias. Desde o acoplamento por nome (2026-07-10) a
 * FONTE DE VERDADE das categorias atribuiveis a produto e a tabela `categories`
 * (lib/data/categories) — o admin pode criar novas alem destas. Este union/const
 * permanece como o conjunto de PRIMEIRA CLASSE: alimenta o seed da tabela, os
 * defaults de frete por categoria (superfrete/dimensions) e a curadoria da home
 * (homeCategories). Por isso Product.category e `string` (qualquer nome da tabela),
 * nao este union restrito.
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
  /** Nome da categoria (fonte de verdade: tabela `categories`). String livre — nao
   * mais restrito ao union Category, que agora e so o conjunto canonico/seed. */
  category: string;
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
  /** Estoque fisico atual em unidades (on-hand). */
  stock: number;
  /**
   * Disponivel para venda = max(0, stock - reservado). Derivado: exclui unidades
   * ja comprometidas por pedidos pendentes (reserva de checkout). A vitrine usa
   * ESTE valor (nao o stock cru) para esgotado/limite de quantidade. O admin
   * continua vendo stock e reservado separados.
   */
  available: number;
  isActive: boolean;
  /** Exibir no carrossel "Em destaque" da landing (controle do admin). */
  isLanding: boolean;
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
  /** Numero e bairro: exigidos pela etiqueta. null em pedidos legados. */
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
}

/** Etiqueta de envio emitida no SuperFrete (estado atual do pedido). */
export interface OrderShippingLabel {
  superFreteId: string;
  /** pending | released | posted | delivered | canceled (vocabulario do provedor). */
  status: string;
  paid: boolean;
  /** Custo pago pela loja, em centavos. */
  costCents: number;
  /** PDF imprimivel, quando o provedor ja emitiu. */
  labelUrl: string | null;
  trackingCode: string | null;
}

export interface Order {
  /** Numero legivel sequencial (ex.: "#10421"). */
  id: string;
  /** Referencia ao usuario (clerk_user_id no DB). Mock ate F9. */
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** CPF/CNPJ do destinatario (so digitos); null em pedidos legados. */
  customerDocument: string | null;
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
  /** Codigo numerico da modalidade cotada (1=PAC, 2=SEDEX, 31=Loggi). */
  shippingServiceCode: number | null;
  shippingDays: string | null;
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  shippingStatus: ShippingStatus;
  /** Codigo de rastreio do objeto (preenchido pelo admin ao despachar). */
  trackingCode: string | null;
  /** Id do transportador (lib/data/carriers); null se nao definido. */
  shippingCarrier: string | null;
  internalNote: string | null;
  /** Etiqueta emitida, quando houver. */
  shippingLabel: OrderShippingLabel | null;
  /** ISO 8601. */
  createdAt: string;
}

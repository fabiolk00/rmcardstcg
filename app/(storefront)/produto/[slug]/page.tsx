import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { SITE_NAME, absoluteUrl } from "@/lib/config/site";
import { finalPriceCents } from "@/lib/data/pricing";
import { getProductBySlug, getRelatedProducts } from "@/lib/data/products";
import { getApprovedReviews, getReviewStats } from "@/lib/data/reviews";
import type { Product } from "@/lib/data/types";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { Breadcrumb } from "@/components/product/Breadcrumb";
import { ProductGallery } from "@/components/product/ProductGallery";
import { ProductInfo } from "@/components/product/ProductInfo";
import { RelatedProducts } from "@/components/product/RelatedProducts";
import { ReviewForm } from "@/components/product/ReviewForm";
import { ReviewsList } from "@/components/product/ReviewsList";
import { ReviewStats } from "@/components/product/ReviewStats";
import { ReviewsSummary } from "@/components/product/ReviewsSummary";
import styles from "./produto.module.css";

// Catalogo ao vivo (reflete edicoes do admin e estoque na hora). Sem build-time
// para nao exigir DB no build mock-first (mesma escolha das outras telas).
export const dynamic = "force-dynamic";

// Dedupe a leitura do produto entre generateMetadata e o componente da pagina
// (React cache por request): um unico SELECT por slug, nao dois.
const loadProduct = cache((slug: string): Promise<Product | null> => getProductBySlug(slug));

function descriptionFor(product: Product): string {
  return product.description.trim()
    ? product.description
    : `${product.name} (${product.category}) na ${SITE_NAME} — pronta-entrega, com garantia de originalidade e envio para todo o Brasil.`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await loadProduct(slug);
  // Inativo = soft-delete: sai da vitrine. Nao expor metadata indexavel dele.
  if (!product || !product.isActive) return { title: `Produto não encontrado — ${SITE_NAME}` };

  const title = `${product.name} — ${SITE_NAME}`;
  const description = descriptionFor(product);
  const image = absoluteUrl(product.imageUrl);
  const url = absoluteUrl(`/produto/${product.slug}`);

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      title,
      description,
      url,
      siteName: SITE_NAME,
      images: [{ url: image, alt: product.name }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

/** JSON-LD schema.org/Product para rich results. Escapa "<" (anti-breakout de <script>). */
function productJsonLd(product: Product): string {
  const url = absoluteUrl(`/produto/${product.slug}`);
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    image: [absoluteUrl(product.imageUrl)],
    description: descriptionFor(product),
    sku: product.sku,
    category: product.category,
    brand: { "@type": "Brand", name: SITE_NAME },
    offers: {
      "@type": "Offer",
      url,
      priceCurrency: "BRL",
      price: (finalPriceCents(product) / 100).toFixed(2),
      availability:
        product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
    },
  };
  if (product.reviewCount > 0) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: product.rating.toFixed(1),
      reviewCount: product.reviewCount,
    };
  }
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function ProdutoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await loadProduct(slug);
  // Produto inexistente OU inativo (soft-delete) -> 404: nao deve aparecer na
  // vitrine (alinha com getActiveProducts/getRelatedProducts e o carrinho).
  if (!product || !product.isActive) notFound();

  // Tudo em paralelo (sem N+1): relacionados, agregado e 1a pagina de aprovadas.
  // O total exibido (Mostrando N de M) vem do groupBy do reviewStats — sem um
  // count() redundante sobre o mesmo predicado.
  const [related, reviewStats, reviews] = await Promise.all([
    getRelatedProducts(product),
    getReviewStats(product.id),
    getApprovedReviews(product.id),
  ]);

  // Gating do formulario: com Clerk ativo, so autenticado avalia; mock-first libera.
  let canReview = true;
  if (isClerkConfigured()) {
    const { userId } = await auth();
    canReview = Boolean(userId);
  }

  return (
    <article className={styles.wrap}>
      <Breadcrumb
        items={[
          { label: "Início", href: "/" },
          { label: "Coleções", href: "/colecoes" },
          {
            label: product.category,
            href: `/colecoes?cat=${encodeURIComponent(product.category)}`,
          },
          { label: product.name },
        ]}
      />

      {/* key={product.id}: remonta os islands client ao navegar entre produtos
          (mesmo segmento [slug]) para nao herdar estado (qty/imagem) do anterior. */}
      <div className={styles.top}>
        <ProductGallery
          key={product.id}
          images={[product.imageUrl]}
          alt={product.name}
          badge={product.badge}
        />
        <ProductInfo key={product.id} product={product} />
      </div>

      {product.description.trim() && (
        <section className={styles.descSection} aria-label="Descrição">
          <h2 className={styles.descTitle}>Descrição</h2>
          <p className={styles.desc}>{product.description}</p>
        </section>
      )}

      <ReviewsSummary rating={product.rating} reviewCount={product.reviewCount}>
        <ReviewStats stats={reviewStats} />
        <ReviewForm slug={product.slug} canReview={canReview} />
        <ReviewsList reviews={reviews} total={reviewStats.count} />
      </ReviewsSummary>

      <RelatedProducts products={related} />

      <script
        type="application/ld+json"
        // JSON serializado e escapado (productJsonLd) — sem dados do usuario nao
        // confiaveis; "<" ja neutralizado contra breakout de <script>.
        dangerouslySetInnerHTML={{ __html: productJsonLd(product) }}
      />
    </article>
  );
}

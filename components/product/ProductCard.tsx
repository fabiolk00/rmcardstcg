import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/data/types";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import styles from "./ProductCard.module.css";

function Stars({ rating }: { rating: number }) {
  const rounded = Math.round(rating);
  return (
    <span className={styles.stars} role="img" aria-label={`Nota ${rating.toFixed(1)} de 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <svg
          key={i}
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill={i < rounded ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ))}
    </span>
  );
}

export function ProductCard({ product }: { product: Product }) {
  const href = `/produto/${product.slug}`;
  const hasDiscount = product.discountPct > 0;
  const final = finalPriceCents(product);
  const soldOut = product.stock <= 0;

  return (
    <article className={styles.card}>
      <Link href={href} className={styles.pic}>
        {product.badge && <span className={styles.badge}>{product.badge}</span>}
        <Image
          src={product.imageUrl}
          alt={product.name}
          fill
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
          className={styles.img}
        />
      </Link>

      <div className={styles.info}>
        <div className={styles.cat}>{product.category}</div>
        <h3 className={styles.name}>
          <Link href={href}>{product.name}</Link>
        </h3>

        <div className={styles.rating}>
          <Stars rating={product.rating} />
          <span className={styles.ratingValue}>{product.rating.toFixed(1)}</span>
          <span className={styles.ratingCount}>· {product.reviewCount} avaliações</span>
        </div>

        <div className={styles.foot}>
          <div className={styles.priceBlock}>
            {hasDiscount && (
              <span className={`${styles.strike} tnum`}>{formatBRL(product.priceCents)}</span>
            )}
            <span className={`${styles.price} tnum`}>{formatBRL(final)}</span>
          </div>

          {soldOut ? (
            <span className={styles.soldout}>Esgotado</span>
          ) : (
            <Link href={href} className={styles.add} aria-label={`Compre agora: ${product.name}`}>
              <span>Compre agora</span>
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}

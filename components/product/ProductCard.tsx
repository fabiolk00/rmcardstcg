import Image from "next/image";
import Link from "next/link";
import type { Product } from "@/lib/data/types";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import { AddToCartButton } from "./AddToCartButton";
import { Stars } from "./Stars";
import styles from "./ProductCard.module.css";

export function ProductCard({ product }: { product: Product }) {
  const href = `/produto/${product.slug}`;
  const hasDiscount = product.discountPct > 0;
  const final = finalPriceCents(product);
  const soldOut = product.available <= 0;

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
          <Stars rating={product.rating} size={13} className={styles.stars} />
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
            <AddToCartButton product={product} />
          )}
        </div>
      </div>
    </article>
  );
}

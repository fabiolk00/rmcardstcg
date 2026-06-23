import type { Product } from "@/lib/data/types";
import { ProductGrid } from "./ProductGrid";
import styles from "./RelatedProducts.module.css";

/**
 * Grade de produtos relacionados (mesma categoria) no rodape da pagina de produto.
 * Reutiliza ProductGrid/ProductCard (zero duplicacao). Nao renderiza nada quando
 * nao ha relacionados.
 */
export function RelatedProducts({ products }: { products: Product[] }) {
  if (products.length === 0) return null;

  return (
    <section className={styles.section} aria-label="Produtos relacionados">
      <h2 className={styles.title}>Você também pode gostar</h2>
      <ProductGrid products={products} />
    </section>
  );
}

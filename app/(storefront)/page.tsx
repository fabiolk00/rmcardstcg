import { getActiveProducts } from "@/lib/data/products";
import { ProductGrid } from "@/components/product/ProductGrid";
import styles from "./page.module.css";

export default async function LandingPage() {
  const products = await getActiveProducts();
  return (
    <section>
      <div className={styles.intro}>
        <h1>Produtos</h1>
        <p className={styles.introSub}>Vitrine (placeholder — landing completa no slice F3).</p>
      </div>
      <ProductGrid products={products} />
    </section>
  );
}

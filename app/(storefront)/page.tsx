import Link from "next/link";
import { getActiveProducts } from "@/lib/data/products";
import { selectCarouselProducts } from "@/lib/data/carousel";
import { CATEGORIES, type Category } from "@/lib/data/types";
import { ProductGrid } from "@/components/product/ProductGrid";
import { HeroPokemon } from "@/components/home/HeroPokemon";
import { Icon, type IconName } from "@/components/ui/Icon";
import styles from "./page.module.css";

// Le do banco a cada request (catalogo reflete edicoes do admin na hora).
// Otimizacao futura: trocar por `export const revalidate = 60` (ISR).
export const dynamic = "force-dynamic";

const CATEGORY_ICON: Record<Category, IconName> = {
  "Booster Box": "box",
  "Elite Trainer Box": "archive",
  "Booster Pack": "layers",
  "Blister Triplo": "layers",
  "Blister Quadruplo": "layers",
  "Coleção Especial": "shield",
  Tin: "package",
  Acessórios: "sleeves",
  "Single Card": "card",
};

export default async function LandingPage() {
  const products = await getActiveProducts();
  const counts = CATEGORIES.map((category) => ({
    category,
    count: products.filter((p) => p.category === category).length,
  }));
  // Carrossel "Em destaque": produtos marcados (isCarousel) e com estoque; cai para
  // os ativos com estoque quando ninguem esta marcado (ver selectCarouselProducts).
  const featured = selectCarouselProducts(products);

  return (
    <>
      <HeroPokemon />

      <section className={styles.cats} aria-label="Categorias">
        <div className={styles.catGrid}>
          {counts.map(({ category, count }) => (
            <Link
              key={category}
              href={`/colecoes?cat=${encodeURIComponent(category)}`}
              className={styles.catTile}
            >
              <span className={styles.catIcon}>
                <Icon name={CATEGORY_ICON[category]} size={18} />
              </span>
              <span className={styles.catText}>
                <span className={styles.catName}>{category}</span>
                <span className={styles.catCount}>
                  {count} {count === 1 ? "produto" : "produtos"}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section id="produtos" className={styles.products}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionEyebrow}>Em destaque</div>
            <h2 className={styles.sectionTitle}>Nossos produtos.</h2>
          </div>
          <Link href="/colecoes" className={styles.seeAll}>
            Ver coleção completa <Icon name="arrow" size={16} />
          </Link>
        </div>
        <ProductGrid products={featured} />
      </section>
    </>
  );
}

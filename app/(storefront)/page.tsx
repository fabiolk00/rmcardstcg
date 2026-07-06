import Link from "next/link";
import { redirectClienteToPainel } from "@/lib/auth/resolveViewer";
import { getActiveProducts } from "@/lib/data/products";
import { selectCarouselProducts } from "@/lib/data/carousel";
import { ProductGrid } from "@/components/product/ProductGrid";
import { HeroPokemon } from "@/components/home/HeroPokemon";
import { Icon } from "@/components/ui/Icon";
import styles from "./page.module.css";

// Le do banco a cada request (catalogo reflete edicoes do admin na hora).
// Otimizacao futura: trocar por `export const revalidate = 60` (ISR).
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  // Cliente logado vive no painel: abrir o site cai direto nos pedidos (a
  // vitrine publica e para anonimos; admin navega a loja normalmente).
  await redirectClienteToPainel("/painel/pedidos");

  const products = await getActiveProducts();
  // Carrossel "Em destaque": produtos marcados (isLanding) e com estoque; cai para
  // os ativos com estoque quando ninguem esta marcado (ver selectCarouselProducts).
  const featured = selectCarouselProducts(products);

  return (
    <>
      <HeroPokemon />

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

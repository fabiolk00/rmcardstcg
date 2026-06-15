import { unstable_cache } from "next/cache";

import { getActiveProducts } from "@/lib/data/products";
import { CATEGORIES, type Category } from "@/lib/data/types";
import { ColecoesView } from "@/components/product/ColecoesView";
import styles from "./colecoes.module.css";

// Pagina dinamica (sem geracao em build-time, p/ nao exigir DB no build mock-first),
// mas o catalogo e cacheado por 60s no Data Cache do Next: requests dentro da janela
// reusam o resultado em vez de baterem no pooler (mitiga thundering herd). Edicoes do
// admin refletem em ate 60s.
export const dynamic = "force-dynamic";

const getCachedActiveProducts = unstable_cache(() => getActiveProducts(), ["active-products"], {
  revalidate: 60,
  tags: ["products"],
});

function resolveCategory(raw: string | undefined): "all" | Category {
  if (!raw) return "all";
  const match = CATEGORIES.find((c) => c.toLowerCase() === raw.toLowerCase());
  return match ?? "all";
}

export default async function ColecoesPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>;
}) {
  const { cat } = await searchParams;
  const products = await getCachedActiveProducts();
  const initialCategory = resolveCategory(cat);

  const avgRating =
    products.length > 0
      ? (products.reduce((sum, p) => sum + p.rating, 0) / products.length).toFixed(1)
      : "0.0";

  return (
    <>
      <section className={styles.hero}>
        <div className={styles.eyebrow}>Catálogo completo</div>
        <h1 className={styles.title}>Todas as cartas e produtos em um só lugar.</h1>
        <p className={styles.sub}>
          Booster Boxes, Elite Trainer Boxes, Tins, cartas avulsas e acessórios — curadoria
          atualizada diariamente, com garantia de originalidade e envio para todo o Brasil.
        </p>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <span className={styles.statV}>{products.length}</span>
            <span className={styles.statL}>Produtos no catálogo</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statV}>{CATEGORIES.length}</span>
            <span className={styles.statL}>Categorias</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statV}>{avgRating}★</span>
            <span className={styles.statL}>Avaliação média</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statV}>48h</span>
            <span className={styles.statL}>Entrega expressa</span>
          </div>
        </div>
      </section>

      <ColecoesView products={products} initialCategory={initialCategory} />
    </>
  );
}

import { unstable_cache } from "next/cache";

import { redirectClienteToPainel } from "@/lib/auth/resolveViewer";
import { FEATURED_AVG_RATING } from "@/lib/config/site";
import { getActiveProducts } from "@/lib/data/products";
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

export default async function ColecoesPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>;
}) {
  const { cat } = await searchParams;
  // Cliente logado navega as colecoes DENTRO do painel (mesma tela, mesmo ?cat=).
  await redirectClienteToPainel(
    cat ? `/painel/colecoes?cat=${encodeURIComponent(cat)}` : "/painel/colecoes",
  );

  const products = await getCachedActiveProducts();
  // Categorias exibidas no catalogo = as presentes nos produtos ativos (fonte de verdade).
  const categoryCount = new Set(products.map((p) => p.category)).size;

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
            <span className={styles.statV}>{categoryCount}</span>
            <span className={styles.statL}>Categorias</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statV}>
              {FEATURED_AVG_RATING}
              <span aria-hidden="true" className={styles.star}>
                ★
              </span>
            </span>
            <span className={styles.statL}>Avaliação média</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statV}>24h</span>
            <span className={styles.statL}>Entrega expressa</span>
          </div>
        </div>
      </section>

      <ColecoesView products={products} initialCategory={cat ?? "all"} />
    </>
  );
}

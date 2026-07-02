import { unstable_cache } from "next/cache";

import { getActiveProducts } from "@/lib/data/products";
import { CATEGORIES, type Category } from "@/lib/data/types";
import { ColecoesView } from "@/components/product/ColecoesView";
import styles from "./colecoes.module.css";

// Espelho da vitrine publica (app/(storefront)/colecoes/page.tsx): MESMA fonte de
// dados (catalogo ativo via lib/data/products), mesmo cache (chave/tag compartilhadas
// com a vitrine — 60s no Data Cache) e mesmo suporte a ?cat=. Sem o hero da vitrine:
// dentro do painel basta o titulo curto no padrao das paginas admin.
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

export default async function PainelColecoesPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>;
}) {
  const { cat } = await searchParams;
  // Erro de leitura do catalogo NAO e engolido: propaga para o error boundary padrao.
  const products = await getCachedActiveProducts();
  const initialCategory = resolveCategory(cat);

  return (
    <div>
      <div className={styles.head}>
        <h1 className={styles.title}>Coleções</h1>
        <p className={styles.sub}>Todo o catálogo ativo da loja, direto do seu painel.</p>
      </div>

      {products.length === 0 ? (
        // Catalogo vazio (sem produtos ativos): mensagem simples, sem toolbar/filtros.
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>O catálogo está vazio no momento.</div>
          <div className={styles.emptySub}>Volte em breve — novos produtos chegam logo.</div>
        </div>
      ) : (
        <ColecoesView products={products} initialCategory={initialCategory} />
      )}
    </div>
  );
}

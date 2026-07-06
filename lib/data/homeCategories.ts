import type { IconName } from "@/components/ui/Icon";
import type { Category } from "./types";

/**
 * Índice editorial de categorias da home (handoff "Landing Ideias").
 *
 * Dado puro (sem DB): cada card aponta para uma categoria REAL do catálogo, então
 * o link cai em /colecoes?cat=<categoria> e o filtro de coleções funciona de fato
 * (mesma convenção do Footer). Um teste de unidade garante que toda `category`
 * aqui existe em CATEGORIES — se alguém renomear uma categoria, o card quebra o
 * teste em vez de virar um filtro morto em produção.
 */
export interface HomeCategory {
  /** Numeral editorial exibido no card (01–04). */
  index: string;
  /** Ícone do design system (components/ui/Icon). */
  icon: IconName;
  title: string;
  description: string;
  /** Categoria real do catálogo — alimenta o filtro em /colecoes?cat=. */
  category: Category;
  /** Card largo (ocupa 2 colunas) na grade editorial do desktop. */
  wide?: boolean;
}

export const HOME_CATEGORIES: readonly HomeCategory[] = [
  {
    index: "01",
    icon: "box",
    title: "Booster Boxes",
    description: "Caixas lacradas de 36 packs",
    category: "Booster Box",
    wide: true,
  },
  {
    index: "02",
    icon: "archive",
    title: "Elite Trainer Boxes",
    description: "Packs, sleeves e acessórios",
    category: "Elite Trainer Box",
  },
  {
    index: "03",
    icon: "card",
    title: "Cartas avulsas",
    description: "Singles raras e promos",
    category: "Single Card",
  },
  {
    index: "04",
    icon: "sleeves",
    title: "Acessórios",
    description: "Sleeves, playmats e deck boxes",
    category: "Acessórios",
    wide: true,
  },
] as const;

/** Link para a coleção filtrada por categoria (mesma convenção do Footer). */
export function collectionHref(category?: Category): string {
  return category ? `/colecoes?cat=${encodeURIComponent(category)}` : "/colecoes";
}

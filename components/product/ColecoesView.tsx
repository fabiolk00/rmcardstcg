"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Product, Category } from "@/lib/data/types";
import { CATEGORIES } from "@/lib/data/types";
import { REVIEWS_ENABLED } from "@/lib/config/features";
import { finalPriceCents } from "@/lib/data/pricing";
import { ProductGrid } from "./ProductGrid";
import { Pagination } from "@/components/ui/Pagination";
import { Icon } from "@/components/ui/Icon";
import styles from "./ColecoesView.module.css";

const PER_PAGE = 12;

type ChipId = "all" | Category;
const CHIPS: { id: ChipId; label: string }[] = [
  { id: "all", label: "Todos" },
  ...CATEGORIES.map((c) => ({ id: c, label: c })),
];

const SORTS = [
  { id: "relevance", label: "Mais relevantes" },
  { id: "priceAsc", label: "Menor preço" },
  { id: "priceDesc", label: "Maior preço" },
  { id: "rating", label: "Melhor avaliados" },
  { id: "discount", label: "Maior desconto" },
] as const;

type SortId = (typeof SORTS)[number]["id"];
const SORT_IDS = SORTS.map((s) => s.id) as readonly SortId[];

// "Melhor avaliados" so faz sentido com reviews visiveis. Com a flag off, some do
// dropdown (o tipo/validacao de URL continua completo: um deep-link ?sort=rating
// ainda ordena por rating, sem quebrar — apenas nao e oferecido).
const VISIBLE_SORTS = SORTS.filter((s) => s.id !== "rating" || REVIEWS_ENABLED);

// Validacao dos valores vindos da URL (entrada nao confiavel): so aceita o que existe.
const isSortId = (v: string | null): v is SortId => v != null && SORT_IDS.includes(v as SortId);
const isChipId = (v: string | null): v is ChipId =>
  v === "all" || CATEGORIES.includes(v as Category);

// Marcas combinantes (acentos) U+0300–U+036F, montadas por codigo p/ manter o fonte ASCII.
const COMBINING_MARKS = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  "g",
);
const norm = (s: string) => s.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();

const matches = (p: Product, q: string) => {
  const nq = norm(q);
  return norm(p.name).includes(nq) || norm(p.category).includes(nq);
};

export function ColecoesView({
  products,
  initialCategory = "all",
}: {
  products: Product[];
  initialCategory?: ChipId;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Estado inicial lido da URL (busca compartilhavel / sobrevive ao refresh); cai no
  // default quando o parametro esta ausente ou invalido. `cat` ja vem resolvido do
  // servidor (?cat=) via initialCategory.
  const [cat, setCat] = useState<ChipId>(initialCategory);
  const [sort, setSort] = useState<SortId>(() => {
    const s = searchParams.get("sort");
    return isSortId(s) ? s : "relevance";
  });
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get("page"));
    return Number.isInteger(p) && p > 0 ? p : 1;
  });
  const topRef = useRef<HTMLDivElement>(null);

  // Mudar filtro/busca volta pra pagina 1. Feito nos handlers (nao em effect) p/ nao
  // apagar o ?page= da URL inicial no primeiro render.
  const onChip = (v: ChipId) => {
    setCat(v);
    setPage(1);
  };
  const onSort = (v: SortId) => {
    setSort(v);
    setPage(1);
  };
  const onSearch = (v: string) => {
    setQuery(v);
    setPage(1);
  };
  const clearFilters = () => {
    setQuery("");
    setCat("all");
    setPage(1);
  };

  // Espelha o estado na URL via replace (sem rolar, sem poluir o historico). O estado
  // e a fonte de verdade e nao lemos de volta, entao nao ha loop render<->URL. Omite
  // os parametros que estao no default p/ manter a URL limpa.
  useEffect(() => {
    const params = new URLSearchParams();
    if (cat !== "all") params.set("cat", cat);
    if (sort !== "relevance") params.set("sort", sort);
    if (query.trim()) params.set("q", query);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [cat, sort, query, page, pathname, router]);

  // Contagem por categoria refletindo a busca ativa (ignora a categoria selecionada).
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    CATEGORIES.forEach((category) => (c[category] = 0));
    for (const p of products) {
      if (query.trim() && !matches(p, query)) continue;
      c.all += 1;
      c[p.category] += 1;
    }
    return c;
  }, [products, query]);

  const filtered = useMemo(() => {
    let list = products;
    if (cat !== "all") list = list.filter((p) => p.category === cat);
    if (query.trim()) list = list.filter((p) => matches(p, query));

    const sorted = [...list];
    switch (sort) {
      case "priceAsc":
        sorted.sort((a, b) => finalPriceCents(a) - finalPriceCents(b));
        break;
      case "priceDesc":
        sorted.sort((a, b) => finalPriceCents(b) - finalPriceCents(a));
        break;
      case "rating":
        sorted.sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
        break;
      case "discount":
        sorted.sort((a, b) => b.discountPct - a.discountPct);
        break;
    }
    return sorted;
  }, [products, cat, query, sort]);

  // Clampa a pagina ao total disponivel: evita um frame com grid vazio quando a busca
  // encurta o resultado e o estado de pagina ainda nao foi corrigido.
  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);
  const activeChip = CHIPS.find((c) => c.id === cat);

  const handlePage = (p: number) => {
    setPage(p);
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div>
      <div className={styles.toolbar} ref={topRef}>
        <div className={styles.search}>
          <Icon name="search" size={16} />
          <input
            type="text"
            value={query}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Buscar por nome ou categoria…"
            aria-label="Buscar produtos"
          />
        </div>
        <select
          className={styles.sort}
          value={sort}
          onChange={(e) => onSort(e.target.value as SortId)}
          aria-label="Ordenar produtos"
        >
          {VISIBLE_SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <div className={styles.count}>
          Mostrando <b>{filtered.length}</b> {filtered.length === 1 ? "produto" : "produtos"}
          {cat !== "all" && activeChip && (
            <>
              {" "}
              em <b>{activeChip.label}</b>
            </>
          )}
        </div>
      </div>

      <div className={styles.filters} role="group" aria-label="Filtrar por categoria">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`${styles.chip} ${cat === c.id ? styles.chipActive : ""}`}
            onClick={() => onChip(c.id)}
            aria-pressed={cat === c.id}
          >
            <span>{c.label}</span>
            <span className={styles.chipCount}>{counts[c.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>Nenhum produto encontrado.</div>
          <div className={styles.emptySub}>
            Tente outra busca ou limpe os filtros para ver todo o catálogo.
          </div>
          {(query.trim() !== "" || cat !== "all") && (
            <div>
              <button type="button" className={styles.emptyAction} onClick={clearFilters}>
                Limpar filtros
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className={styles.results}>
          <ProductGrid products={pageItems} />
          <Pagination
            page={safePage}
            total={filtered.length}
            perPage={PER_PAGE}
            onChange={handlePage}
          />
        </div>
      )}
    </div>
  );
}

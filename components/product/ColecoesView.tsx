"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Product, Category } from "@/lib/data/types";
import { CATEGORIES } from "@/lib/data/types";
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
  const [cat, setCat] = useState<ChipId>(initialCategory);
  const [sort, setSort] = useState<SortId>("relevance");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset de pagina ao mudar filtro (intencional)
    setPage(1);
  }, [cat, sort, query]);

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

  const pageItems = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nome, expansão ou categoria…"
            aria-label="Buscar produtos"
          />
        </div>
        <select
          className={styles.sort}
          value={sort}
          onChange={(e) => setSort(e.target.value as SortId)}
          aria-label="Ordenar produtos"
        >
          {SORTS.map((s) => (
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
            onClick={() => setCat(c.id)}
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
              <button
                type="button"
                className={styles.emptyAction}
                onClick={() => {
                  setQuery("");
                  setCat("all");
                }}
              >
                Limpar filtros
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className={styles.results}>
          <ProductGrid products={pageItems} />
          <Pagination
            page={page}
            total={filtered.length}
            perPage={PER_PAGE}
            onChange={handlePage}
          />
        </div>
      )}
    </div>
  );
}

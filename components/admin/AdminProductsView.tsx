"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import type { Product } from "@/lib/data/types";
import { CATEGORIES } from "@/lib/data/types";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import { Icon } from "@/components/ui/Icon";
import { Pagination } from "@/components/ui/Pagination";
import { ProductFormModal, type ProductFormPayload } from "./ProductFormModal";
import { InactivateModal } from "./InactivateModal";
import {
  createProductAction,
  setProductActiveAction,
  updateProductAction,
} from "@/app/admin/produtos/actions";
import styles from "./AdminProductsView.module.css";

const PER_PAGE = 8;
type StatusFilter = "all" | "active" | "inactive";

function blankProduct(): Product {
  return {
    id: "",
    slug: "",
    name: "",
    category: "Booster Box",
    sku: "",
    priceCents: 0,
    discountPct: 0,
    rating: 0,
    reviewCount: 0,
    stock: 0,
    isActive: true,
    badge: null,
    imageUrl: "/products/placeholder.svg",
    description: "",
    createdAt: "",
  };
}

export function AdminProductsView({ products: initialProducts }: { products: Product[] }) {
  // Mutacoes em estado de cliente (efemeras no mock). Persistencia real no F10.
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Product | null>(null);
  const [confirmInactivate, setConfirmInactivate] = useState<Product | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const counts = useMemo(
    () => ({
      total: products.length,
      active: products.filter((p) => p.isActive).length,
      inactive: products.filter((p) => !p.isActive).length,
    }),
    [products],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (
        q &&
        !(
          p.name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q)
        )
      ) {
        return false;
      }
      if (status === "active" && !p.isActive) return false;
      if (status === "inactive" && p.isActive) return false;
      if (cats.size > 0 && !cats.has(p.category)) return false;
      return true;
    });
  }, [products, query, status, cats]);

  const paged = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const hasFilters = query !== "" || status !== "all" || cats.size > 0;

  const toggleCat = (c: string) => {
    setCats((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
    setPage(1);
  };

  const clearFilters = () => {
    setQuery("");
    setStatus("all");
    setCats(new Set());
    setPage(1);
  };

  // Persiste via server action. Em sucesso, reflete o produto retornado na lista
  // local (o revalidatePath ja atualizou o SSR para o proximo carregamento).
  const handleSave = async (
    id: string | null,
    payload: ProductFormPayload,
  ): Promise<string | null> => {
    const res = id ? await updateProductAction(id, payload) : await createProductAction(payload);
    if (!res.ok) return res.error;
    const saved = res.data;
    setProducts((prev) => {
      const i = prev.findIndex((x) => x.id === saved.id);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = saved;
        return copy;
      }
      return [saved, ...prev];
    });
    setEditing(null);
    setToast("Produto salvo.");
    return null;
  };

  const handlePower = async (p: Product) => {
    if (p.isActive) {
      setConfirmInactivate(p);
      return;
    }
    const res = await setProductActiveAction(p.id, true);
    if (!res.ok) {
      setToast(res.error);
      return;
    }
    const saved = res.data;
    setProducts((prev) => prev.map((x) => (x.id === saved.id ? saved : x)));
    setToast("Produto reativado.");
  };

  const handleInactivate = async (): Promise<string | null> => {
    if (!confirmInactivate) return null;
    const res = await setProductActiveAction(confirmInactivate.id, false);
    if (!res.ok) return res.error;
    const saved = res.data;
    setProducts((prev) => prev.map((x) => (x.id === saved.id ? saved : x)));
    setConfirmInactivate(null);
    setToast("Produto inativado.");
    return null;
  };

  return (
    <section>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Produtos</h1>
          <p className={styles.sub}>
            {counts.active} ativos · {counts.inactive} inativos · {counts.total} no total
          </p>
        </div>
        <button type="button" className={styles.newBtn} onClick={() => setEditing(blankProduct())}>
          <Icon name="plus" size={15} /> Novo Produto
        </button>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Icon name="search" size={15} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nome, SKU ou ID…"
            aria-label="Buscar produtos"
          />
        </div>
        <div className={styles.seg} role="group" aria-label="Filtrar por status">
          {(["all", "active", "inactive"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              className={status === s ? styles.segOn : ""}
              onClick={() => {
                setStatus(s);
                setPage(1);
              }}
              aria-pressed={status === s}
            >
              {s === "all" ? "Todos" : s === "active" ? "Ativos" : "Inativos"}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.chips} role="group" aria-label="Filtrar por categoria">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={`${styles.chip} ${cats.has(c) ? styles.chipOn : ""}`}
            onClick={() => toggleCat(c)}
            aria-pressed={cats.has(c)}
          >
            {c}
          </button>
        ))}
        {hasFilters && (
          <button type="button" className={styles.clear} onClick={clearFilters}>
            <Icon name="trash" size={12} /> Limpar
          </button>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.left}>
                ID
              </th>
              <th scope="col" className={styles.left}>
                Produto
              </th>
              <th scope="col" className={styles.left}>
                Categoria
              </th>
              <th scope="col" className={styles.right}>
                Preço
              </th>
              <th scope="col" className={styles.right}>
                Desconto
              </th>
              <th scope="col" className={styles.right}>
                Preço final
              </th>
              <th scope="col" className={styles.center}>
                Estoque
              </th>
              <th scope="col" className={styles.left}>
                Status
              </th>
              <th scope="col" className={styles.right}>
                Ações
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((p) => (
              <tr key={p.id} className={p.isActive ? undefined : styles.inactive}>
                <td className={`${styles.left} ${styles.mono}`}>{p.id}</td>
                <td className={styles.left}>
                  <div className={styles.product}>
                    <span className={styles.thumb}>
                      <Image
                        src={p.imageUrl}
                        alt=""
                        width={36}
                        height={36}
                        className={styles.thumbImg}
                      />
                    </span>
                    <span className={styles.productText}>
                      <span className={styles.name}>{p.name}</span>
                      <span className={styles.skuSub}>SKU {p.sku}</span>
                    </span>
                  </div>
                </td>
                <td className={styles.left}>
                  <span className={styles.catPill}>{p.category}</span>
                </td>
                <td className={`${styles.right} tnum`}>
                  {p.discountPct > 0 ? (
                    <span className={styles.strike}>{formatBRL(p.priceCents)}</span>
                  ) : (
                    formatBRL(p.priceCents)
                  )}
                </td>
                <td className={styles.right}>
                  {p.discountPct > 0 ? (
                    <span className={styles.disc}>-{p.discountPct}%</span>
                  ) : (
                    <span className={styles.muted}>—</span>
                  )}
                </td>
                <td className={`${styles.right} ${styles.finalPrice} tnum`}>
                  {formatBRL(finalPriceCents(p))}
                </td>
                <td className={styles.center}>
                  <span className={`${styles.stock} ${p.stock === 0 ? styles.stockZero : ""} tnum`}>
                    {p.stock}
                  </span>
                  {p.stock > 0 && p.stock < 5 && <span className={styles.stockLow}>baixo</span>}
                </td>
                <td className={styles.left}>
                  <span
                    className={`${styles.pill} ${p.isActive ? styles.pillActive : styles.pillInactive}`}
                  >
                    {p.isActive ? "Ativo" : "Inativo"}
                  </span>
                </td>
                <td className={styles.right}>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.act}
                      onClick={() => setEditing(p)}
                      aria-label={`Editar ${p.name}`}
                      title="Editar"
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      type="button"
                      className={styles.act}
                      onClick={() => handlePower(p)}
                      aria-label={`${p.isActive ? "Inativar" : "Ativar"} ${p.name}`}
                      title={p.isActive ? "Inativar" : "Ativar"}
                    >
                      <Icon name="power" size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={9} className={styles.emptyCell}>
                  Nenhum produto encontrado com esses filtros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} total={filtered.length} perPage={PER_PAGE} onChange={setPage} />

      {editing && (
        <ProductFormModal product={editing} onClose={() => setEditing(null)} onSave={handleSave} />
      )}
      {confirmInactivate && (
        <InactivateModal
          product={confirmInactivate}
          onClose={() => setConfirmInactivate(null)}
          onConfirm={handleInactivate}
        />
      )}
      {toast && (
        <div className={styles.toast} role="status" aria-live="polite" aria-atomic="true">
          {toast}
        </div>
      )}
    </section>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import type { Product } from "@/lib/data/types";
import { CATEGORIES } from "@/lib/data/types";
import { productStatusActions, type ProductStatusKind } from "@/lib/data/product-status";
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
    available: 0,
    isActive: true,
    isCarousel: false,
    badge: null,
    imageUrl: "/products/placeholder.svg",
    description: "",
    weightGrams: 0,
    lengthCm: 0,
    widthCm: 0,
    heightCm: 0,
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
  // Reativacoes em voo. O ref e a fonte de verdade SINCRONA do guard anti
  // double-click: `busyId` (useState) so muda no proximo render, entao dois cliques
  // sincronos leriam o mesmo snapshot stale e ambos passariam — o ref e lido/escrito
  // na hora, fechando a janela. O `busyId` existe so p/ refletir o `disabled` visual
  // do botao enquanto salva. (O servidor tambem e idempotente; isto evita o round-trip
  // e o toast duplicado.) O modal de inativar ja tem o seu proprio estado de busy.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

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
      if (q && !(p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))) {
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
    original: ProductFormPayload | null,
  ): Promise<string | null> => {
    const res = id
      ? await updateProductAction(id, payload, original ?? undefined)
      : await createProductAction(payload);
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

  // Inativar abre o modal de confirmacao (acao destrutiva: tira o produto da loja);
  // reativar e direto, sem friccao (so traz o produto de volta). O servidor
  // (setProductActive) e a fonte de verdade e audita a transicao na mesma transacao.
  const handleStatusAction = async (p: Product, kind: ProductStatusKind) => {
    if (kind === "inactivate") {
      setConfirmInactivate(p);
      return;
    }
    if (inFlightRef.current.has(p.id)) return; // reativacao ja em voo p/ este produto
    inFlightRef.current.add(p.id);
    setBusyId(p.id);
    try {
      const res = await setProductActiveAction(p.id, true);
      if (!res.ok) {
        setToast(res.error);
        return;
      }
      const saved = res.data;
      setProducts((prev) => prev.map((x) => (x.id === saved.id ? saved : x)));
      setToast("Produto reativado.");
    } finally {
      inFlightRef.current.delete(p.id);
      setBusyId(null);
    }
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
            placeholder="Buscar por nome ou SKU…"
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
                  <div className={styles.statusCell}>
                    <span
                      className={`${styles.pill} ${p.isActive ? styles.pillActive : styles.pillInactive}`}
                    >
                      {p.isActive ? "Ativo" : "Inativo"}
                    </span>
                    {p.isCarousel && (
                      <span
                        className={`${styles.pill} ${styles.pillCarousel}`}
                        title="No carrossel"
                      >
                        Carrossel
                      </span>
                    )}
                  </div>
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
                    {productStatusActions(p.isActive).map((a) => {
                      const disabled = !a.enabled || busyId === p.id;
                      return (
                        <button
                          key={a.kind}
                          type="button"
                          className={styles.act}
                          onClick={() => handleStatusAction(p, a.kind)}
                          disabled={disabled}
                          aria-label={`${a.verb} ${p.name}`}
                          // title nao aparece em <button disabled> (browser nao dispara
                          // hover); so o exibimos quando o botao esta acionavel.
                          title={disabled ? undefined : a.verb}
                        >
                          <Icon name={a.icon} size={15} />
                        </button>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={8} className={styles.emptyCell}>
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

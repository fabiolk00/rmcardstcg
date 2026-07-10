"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { Category } from "@/lib/data/categories";
import { Icon } from "@/components/ui/Icon";
import { Pagination } from "@/components/ui/Pagination";
import { CategoryFormModal } from "./CategoryFormModal";
import { DeleteCategoryModal } from "./DeleteCategoryModal";
import {
  createCategoryAction,
  deleteCategoryAction,
  updateCategoryAction,
  type CategoryFormPayload,
} from "@/app/admin/categorias/actions";
import styles from "./AdminCategoriesView.module.css";

const PER_PAGE = 8;

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

export function AdminCategoriesView({ categories: initialCategories }: { categories: Category[] }) {
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Mantem o estado em sincronia se o server revalidar a pagina.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync com a prop revalidada pelo server (intencional)
  useEffect(() => setCategories(initialCategories), [initialCategories]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, query]);

  const paged = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const hasFilters = query !== "";

  const upsertLocal = (saved: Category) =>
    setCategories((prev) => {
      const i = prev.findIndex((x) => x.id === saved.id);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = saved;
        return copy;
      }
      return [saved, ...prev];
    });

  // Chamado pelo modal apos validacao client; persiste no server e sincroniza.
  const handleSave = (id: string | null, payload: CategoryFormPayload) => {
    startTransition(async () => {
      const result = id
        ? await updateCategoryAction(id, payload)
        : await createCategoryAction(payload);
      if (result.ok) {
        upsertLocal(result.category);
        setEditing(null);
        setCreating(false);
        setToast("Categoria salva.");
      } else {
        setToast(result.error);
      }
    });
  };

  // Exclusao permanente (o modal gerencia o estado de carregando e exibe o erro).
  const handleDelete = async (): Promise<string | null> => {
    if (!deleting) return null;
    const result = await deleteCategoryAction(deleting.id);
    if (!result.ok) return result.error;
    setCategories((prev) => prev.filter((x) => x.id !== deleting.id));
    setDeleting(null);
    setToast("Categoria excluída.");
    return null;
  };

  return (
    <section>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Categorias</h1>
          <p className={styles.sub}>{categories.length} no total</p>
        </div>
        <button type="button" className={styles.newBtn} onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} /> Nova Categoria
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
            placeholder="Buscar por nome…"
            aria-label="Buscar categorias"
          />
        </div>
        {hasFilters && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => {
              setQuery("");
              setPage(1);
            }}
          >
            <Icon name="trash" size={12} /> Limpar
          </button>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.left}>
                Nome
              </th>
              <th scope="col" className={styles.left}>
                Descrição
              </th>
              <th scope="col" className={styles.left}>
                Criado em
              </th>
              <th scope="col" className={styles.right}>
                Ações
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((c) => (
              <tr key={c.id}>
                <td className={`${styles.left} ${styles.name}`}>{c.name}</td>
                <td className={styles.left}>
                  {c.description ? (
                    <span className={styles.desc}>{c.description}</span>
                  ) : (
                    <span className={styles.muted}>—</span>
                  )}
                </td>
                <td className={styles.left}>{formatDate(c.createdAt)}</td>
                <td className={styles.right}>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.act}
                      onClick={() => setEditing(c)}
                      disabled={pending}
                      aria-label={`Editar ${c.name}`}
                      title="Editar"
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      type="button"
                      className={styles.act}
                      onClick={() => setDeleting(c)}
                      disabled={pending}
                      aria-label={`Excluir ${c.name}`}
                      title="Excluir"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.emptyCell}>
                  Nenhuma categoria encontrada com esses filtros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        total={filtered.length}
        perPage={PER_PAGE}
        onChange={setPage}
        label="categorias"
      />

      {(creating || editing) && (
        <CategoryFormModal
          category={editing}
          pending={pending}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={handleSave}
        />
      )}
      {deleting && (
        <DeleteCategoryModal
          category={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={handleDelete}
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

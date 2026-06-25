"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { Coupon } from "@/lib/data/coupons";
import { formatBRL } from "@/lib/utils/currency";
import { Icon } from "@/components/ui/Icon";
import { Pagination } from "@/components/ui/Pagination";
import { CouponFormModal } from "./CouponFormModal";
import { DeleteCouponModal } from "./DeleteCouponModal";
import {
  createCouponAction,
  deleteCouponAction,
  setCouponActiveAction,
  updateCouponAction,
  type CouponFormPayload,
} from "@/app/admin/cupons/actions";
import styles from "./AdminCouponsView.module.css";

const PER_PAGE = 8;
type StatusFilter = "all" | "active" | "inactive";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

function couponValueLabel(c: Coupon): string {
  if (c.type === "percent" && c.percentOff !== null) return `-${c.percentOff}%`;
  if (c.type === "fixed" && c.valueCents !== null) return `-${formatBRL(c.valueCents)}`;
  return "—";
}

function usageLabel(c: Coupon): string {
  return c.maxRedemptions === null
    ? `${c.redeemedCount} / ∞`
    : `${c.redeemedCount} / ${c.maxRedemptions}`;
}

export function AdminCouponsView({ coupons: initialCoupons }: { coupons: Coupon[] }) {
  const [coupons, setCoupons] = useState<Coupon[]>(initialCoupons);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Coupon | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Mantem o estado em sincronia se o server revalidar a pagina.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync com a prop revalidada pelo server (intencional)
  useEffect(() => setCoupons(initialCoupons), [initialCoupons]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const counts = useMemo(
    () => ({
      total: coupons.length,
      active: coupons.filter((c) => c.isActive).length,
      inactive: coupons.filter((c) => !c.isActive).length,
    }),
    [coupons],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return coupons.filter((c) => {
      if (q && !c.code.toLowerCase().includes(q)) return false;
      if (status === "active" && !c.isActive) return false;
      if (status === "inactive" && c.isActive) return false;
      return true;
    });
  }, [coupons, query, status]);

  const paged = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const hasFilters = query !== "" || status !== "all";

  const upsertLocal = (saved: Coupon) =>
    setCoupons((prev) => {
      const i = prev.findIndex((x) => x.id === saved.id);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = saved;
        return copy;
      }
      return [saved, ...prev];
    });

  // Chamado pelo modal apos validacao client; persiste no server e sincroniza.
  const handleSave = (id: string | null, payload: CouponFormPayload) => {
    startTransition(async () => {
      const result = id ? await updateCouponAction(id, payload) : await createCouponAction(payload);
      if (result.ok) {
        upsertLocal(result.coupon);
        setEditing(null);
        setCreating(false);
        setToast("Cupom salvo.");
      } else {
        setToast(result.error);
      }
    });
  };

  const handleToggle = (c: Coupon) => {
    startTransition(async () => {
      const result = await setCouponActiveAction(c.id, !c.isActive);
      if (result.ok) {
        upsertLocal(result.coupon);
        setToast(c.isActive ? "Cupom inativado." : "Cupom reativado.");
      } else {
        setToast(result.error);
      }
    });
  };

  // Exclusao permanente (o modal gerencia o estado de carregando e exibe o erro).
  const handleDelete = async (): Promise<string | null> => {
    if (!deleting) return null;
    const result = await deleteCouponAction(deleting.id);
    if (!result.ok) return result.error;
    setCoupons((prev) => prev.filter((x) => x.id !== deleting.id));
    setDeleting(null);
    setToast("Cupom excluído.");
    return null;
  };

  return (
    <section>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Cupons</h1>
          <p className={styles.sub}>
            {counts.active} ativos · {counts.inactive} inativos · {counts.total} no total
          </p>
        </div>
        <button type="button" className={styles.newBtn} onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} /> Novo Cupom
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
            placeholder="Buscar por código…"
            aria-label="Buscar cupons"
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
        {hasFilters && (
          <button
            type="button"
            className={styles.clear}
            onClick={() => {
              setQuery("");
              setStatus("all");
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
                Código
              </th>
              <th scope="col" className={styles.right}>
                Desconto
              </th>
              <th scope="col" className={styles.right}>
                Mín. pedido
              </th>
              <th scope="col" className={styles.center}>
                Usos
              </th>
              <th scope="col" className={styles.left}>
                Validade
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
            {paged.map((c) => (
              <tr key={c.id} className={c.isActive ? undefined : styles.inactive}>
                <td className={`${styles.left} ${styles.mono}`}>{c.code}</td>
                <td className={`${styles.right} ${styles.discount} tnum`}>{couponValueLabel(c)}</td>
                <td className={`${styles.right} tnum`}>
                  {c.minSubtotalCents > 0 ? (
                    formatBRL(c.minSubtotalCents)
                  ) : (
                    <span className={styles.muted}>—</span>
                  )}
                </td>
                <td className={`${styles.center} tnum`}>{usageLabel(c)}</td>
                <td className={styles.left}>
                  {formatDate(c.startsAt)} – {formatDate(c.expiresAt)}
                </td>
                <td className={styles.left}>
                  <span
                    className={`${styles.pill} ${c.isActive ? styles.pillActive : styles.pillInactive}`}
                  >
                    {c.isActive ? "Ativo" : "Inativo"}
                  </span>
                </td>
                <td className={styles.right}>
                  <div className={styles.actions}>
                    <Link
                      href={`/admin/cupons/${c.id}`}
                      className={styles.act}
                      aria-label={`Ver usos de ${c.code}`}
                      title="Ver usos"
                    >
                      <Icon name="receipt" size={15} />
                    </Link>
                    <button
                      type="button"
                      className={styles.act}
                      onClick={() => setEditing(c)}
                      disabled={pending}
                      aria-label={`Editar ${c.code}`}
                      title="Editar"
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      type="button"
                      className={styles.act}
                      onClick={() => handleToggle(c)}
                      disabled={pending}
                      aria-label={`${c.isActive ? "Inativar" : "Ativar"} ${c.code}`}
                      title={c.isActive ? "Inativar" : "Ativar"}
                    >
                      <Icon name="power" size={15} />
                    </button>
                    <button
                      type="button"
                      className={styles.act}
                      onClick={() => setDeleting(c)}
                      disabled={pending || c.redeemedCount > 0}
                      aria-label={`Excluir ${c.code}`}
                      title={
                        c.redeemedCount > 0
                          ? "Cupom já utilizado — inative em vez de excluir"
                          : "Excluir"
                      }
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={7} className={styles.emptyCell}>
                  Nenhum cupom encontrado com esses filtros.
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
        label="cupons"
      />

      {(creating || editing) && (
        <CouponFormModal
          coupon={editing}
          pending={pending}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={handleSave}
        />
      )}
      {deleting && (
        <DeleteCouponModal
          coupon={deleting}
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

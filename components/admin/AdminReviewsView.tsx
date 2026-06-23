"use client";

import { useEffect, useState, useTransition } from "react";

import { approveReviewAction, rejectReviewAction } from "@/app/admin/avaliacoes/actions";
import type { PendingReview } from "@/lib/data/reviews";
import { Stars } from "@/components/product/Stars";
import styles from "./AdminReviewsView.module.css";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function AdminReviewsView({ reviews: initial }: { reviews: PendingReview[] }) {
  const [reviews, setReviews] = useState<PendingReview[]>(initial);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Sincroniza com a prop revalidada pelo server.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync com a prop revalidada (intencional)
  useEffect(() => setReviews(initial), [initial]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const moderate = (id: string, target: "approved" | "rejected") => {
    setBusyId(id);
    startTransition(async () => {
      const res =
        target === "approved" ? await approveReviewAction(id) : await rejectReviewAction(id);
      setBusyId(null);
      if (res.ok) {
        setReviews((prev) => prev.filter((r) => r.id !== id));
        setToast(target === "approved" ? "Avaliação aprovada." : "Avaliação rejeitada.");
      } else {
        setToast(res.error);
      }
    });
  };

  return (
    <section>
      <header className={styles.head}>
        <h1 className={styles.title}>Avaliações</h1>
        <p className={styles.sub}>
          {reviews.length}{" "}
          {reviews.length === 1 ? "avaliação pendente" : "avaliações pendentes"} de moderação.
        </p>
      </header>

      {reviews.length === 0 ? (
        <p className={styles.empty}>Nenhuma avaliação pendente. 🎉</p>
      ) : (
        <ul className={styles.list}>
          {reviews.map((r) => {
            const busy = pending && busyId === r.id;
            return (
              <li key={r.id} className={styles.card}>
                <div className={styles.meta}>
                  <Stars rating={r.rating} size={15} />
                  <span className={styles.author}>{r.authorName}</span>
                  <span className={styles.dot} aria-hidden="true">
                    ·
                  </span>
                  <span className={styles.product}>{r.productName}</span>
                  <span className={styles.dot} aria-hidden="true">
                    ·
                  </span>
                  <span className={styles.date}>{formatDate(r.createdAt)}</span>
                </div>
                {r.title && <div className={styles.reviewTitle}>{r.title}</div>}
                <p className={styles.body}>{r.body}</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.approve}
                    onClick={() => moderate(r.id, "approved")}
                    disabled={busy}
                  >
                    Aprovar
                  </button>
                  <button
                    type="button"
                    className={styles.reject}
                    onClick={() => moderate(r.id, "rejected")}
                    disabled={busy}
                  >
                    Rejeitar
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {toast && (
        <div className={styles.toast} role="status">
          {toast}
        </div>
      )}
    </section>
  );
}

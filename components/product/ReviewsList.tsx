import type { Review } from "@/lib/data/types";
import { Stars } from "./Stars";
import styles from "./ReviewsList.module.css";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

/**
 * Lista de avaliacoes APROVADAS (mais recentes primeiro). `total` e a contagem
 * total de aprovadas (para o rodape "mostrando N de M"). Nao renderiza nada quando
 * ainda nao ha avaliacoes aprovadas.
 */
export function ReviewsList({ reviews, total }: { reviews: Review[]; total: number }) {
  if (reviews.length === 0) return null;

  return (
    <div className={styles.list}>
      {reviews.map((r) => (
        <article key={r.id} className={styles.item}>
          <div className={styles.head}>
            <Stars rating={r.rating} size={14} />
            <span className={styles.author}>{r.authorName}</span>
            <span className={styles.date}>{formatDate(r.createdAt)}</span>
          </div>
          {r.title && <h3 className={styles.itemTitle}>{r.title}</h3>}
          <p className={styles.body}>{r.body}</p>
        </article>
      ))}
      {total > reviews.length && (
        <p className={styles.more}>
          Mostrando {reviews.length} de {total} avaliações.
        </p>
      )}
    </div>
  );
}

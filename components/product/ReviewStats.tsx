import type { ReviewStats as Stats } from "@/lib/data/types";
import styles from "./ReviewStats.module.css";

/**
 * Distribuicao das notas (5★..1★) das avaliacoes APROVADAS. Nao renderiza nada
 * quando ainda nao ha avaliacoes reais (o agregado decorativo fica no ReviewsSummary).
 */
export function ReviewStats({ stats }: { stats: Stats }) {
  if (stats.count === 0) return null;
  const rows = [5, 4, 3, 2, 1] as const;

  return (
    <div className={styles.stats} aria-label="Distribuição das notas">
      {rows.map((star) => {
        const n = stats.distribution[star];
        const pct = stats.count > 0 ? Math.round((n / stats.count) * 100) : 0;
        return (
          <div key={star} className={styles.row}>
            <span className={styles.label}>{star}★</span>
            <span className={styles.track}>
              <span className={styles.fill} style={{ width: `${pct}%` }} />
            </span>
            <span className={styles.count}>{n}</span>
          </div>
        );
      })}
    </div>
  );
}

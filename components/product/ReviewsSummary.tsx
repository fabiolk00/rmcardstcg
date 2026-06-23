import { Stars } from "./Stars";
import styles from "./ReviewsSummary.module.css";

/**
 * Resumo de avaliacoes da pagina de produto. Hoje exibe o agregado (rating /
 * reviewCount) que vem do produto — ESTATICO, conforme o slice atual. A estrutura
 * ja esta preparada para o sistema dinamico (Feature 2): o slot `children` recebera
 * o formulario de avaliacao + a lista de reviews aprovadas sem mudar este layout.
 */
export function ReviewsSummary({
  rating,
  reviewCount,
  children,
}: {
  rating: number;
  reviewCount: number;
  children?: React.ReactNode;
}) {
  return (
    <section className={styles.section} id="avaliacoes" aria-label="Avaliações">
      <h2 className={styles.title}>Avaliações</h2>

      {reviewCount > 0 ? (
        <div className={styles.summary}>
          <div className={styles.scoreBox}>
            <span className={styles.score}>{rating.toFixed(1)}</span>
            <Stars rating={rating} size={18} />
            <span className={styles.count}>
              {reviewCount} {reviewCount === 1 ? "avaliação" : "avaliações"}
            </span>
          </div>
          <p className={styles.note}>
            Nota média baseada nas avaliações verificadas de quem comprou.
          </p>
        </div>
      ) : (
        <p className={styles.empty}>Este produto ainda não recebeu avaliações.</p>
      )}

      {children}
    </section>
  );
}

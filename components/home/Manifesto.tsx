import { Fragment } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import styles from "./Manifesto.module.css";

// Faixa "Garantia RM Cards" em tinta (handoff "Landing Ideias"): manifesto +
// métricas + CTA para o catálogo. Full-bleed, encosta no rodapé (ver page.module.css).
const STATS: { value: string; star?: boolean; label: string }[] = [
  { value: "4.9", star: true, label: "Avaliação média" },
  { value: "48h", label: "Envio médio" },
  { value: "100%", label: "Originais lacradas" },
];

export function Manifesto() {
  return (
    <section className={styles.section} aria-labelledby="manifesto-heading">
      <div className={`container ${styles.inner}`}>
        <span className={styles.eyebrow}>Garantia RM Cards</span>
        <h2 id="manifesto-heading" className={styles.headline}>
          Toda carta sai lacrada, conferida e rastreada.
        </h2>

        <div className={styles.row}>
          <div className={styles.stats}>
            {STATS.map((s, i) => (
              <Fragment key={s.label}>
                {i > 0 && <span className={styles.divider} aria-hidden="true" />}
                <div className={styles.stat}>
                  <span className={`${styles.statValue} tnum`}>
                    {s.value}
                    {s.star && (
                      <span aria-hidden="true" className={styles.star}>
                        ★
                      </span>
                    )}
                  </span>
                  <span className={styles.statLabel}>{s.label}</span>
                </div>
              </Fragment>
            ))}
          </div>

          <Link href="/colecoes" className={styles.cta}>
            Ver coleção completa
            <Icon name="arrow" size={18} />
          </Link>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";
import { HOME_CATEGORIES, collectionHref } from "@/lib/data/homeCategories";
import { Icon } from "@/components/ui/Icon";
import styles from "./CategoryIndex.module.css";

// Índice editorial de categorias (handoff "Landing Ideias"). Grade assimétrica no
// desktop (cards 01/04 ocupam 2 colunas), 2×2 no tablet e carrossel horizontal no
// mobile. Cada card leva ao catálogo filtrado pela categoria real (?cat=), então o
// filtro de /colecoes continua funcionando — nossa funcionalidade sobre o layout novo.
export function CategoryIndex() {
  return (
    <section className={styles.section} aria-labelledby="categorias-heading">
      <div className={`container ${styles.inner}`}>
        <div className={styles.head}>
          <div className={styles.eyebrow}>Categorias</div>
          <h2 id="categorias-heading" className={styles.title}>
            Navegue por categoria.
          </h2>
        </div>

        <div className={styles.grid}>
          {HOME_CATEGORIES.map((c) => (
            <Link
              key={c.index}
              href={collectionHref(c.category)}
              className={`${styles.card} ${c.wide ? styles.wide : ""}`}
            >
              <span className={styles.bgIcon} aria-hidden="true">
                <Icon name={c.icon} size={c.wide ? 210 : 180} />
              </span>

              <span className={styles.cardTop}>
                <span className={styles.tile}>
                  <Icon name={c.icon} size={26} />
                </span>
                <span className={`${styles.num} tnum`}>{c.index}</span>
              </span>

              <span className={styles.cardMeta}>
                <span className={styles.cardTitle}>{c.title}</span>
                <span className={styles.cardDesc}>
                  {c.description}
                  <Icon name="arrow" size={16} />
                </span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

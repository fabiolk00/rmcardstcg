import Link from "next/link";
import Image from "next/image";
import { HOME_CATEGORIES, collectionHref } from "@/lib/data/homeCategories";
import { Icon } from "@/components/ui/Icon";
import styles from "./CategoryIndex.module.css";

// Índice editorial de categorias (handoff "Landing Ideias", visual 1c: arte oficial
// de Pokémon colorida como marca d'água). Grade assimétrica no desktop (cards 01/04
// ocupam 2 colunas), 2×2 no tablet e carrossel horizontal no mobile. Cada card leva
// ao catálogo filtrado pela categoria real (?cat=), então o filtro de /colecoes
// continua funcionando — nossa funcionalidade sobre o layout novo.
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
              <Image
                src={c.art}
                alt=""
                width={230}
                height={230}
                className={styles.art}
                aria-hidden="true"
              />

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

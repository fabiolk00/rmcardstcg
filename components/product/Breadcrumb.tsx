import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import styles from "./Breadcrumb.module.css";

export type Crumb = { label: string; href?: string };

/**
 * Trilha de navegacao generica (Inicio > Categoria > Produto). O ultimo item e a
 * pagina atual (aria-current="page"), sem link. Componente de servidor (estatico).
 */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className={styles.nav} aria-label="Trilha de navegação">
      <ol className={styles.list}>
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className={styles.item}>
              {item.href && !last ? (
                <Link href={item.href} className={styles.link}>
                  {item.label}
                </Link>
              ) : (
                <span
                  className={last ? styles.current : undefined}
                  aria-current={last ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!last && (
                <span className={styles.sep} aria-hidden="true">
                  <Icon name="chevronRight" size={13} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

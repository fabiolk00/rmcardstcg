import { Icon } from "./Icon";
import styles from "./Pagination.module.css";

type Props = {
  page: number;
  total: number;
  perPage: number;
  onChange: (page: number) => void;
};

// Lista de paginas com reticencias: primeira, ultima e atual +/- 1.
function buildPages(page: number, totalPages: number): (number | "ellipsis")[] {
  const out: (number | "ellipsis")[] = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
      out.push(i);
    } else if (out[out.length - 1] !== "ellipsis") {
      out.push("ellipsis");
    }
  }
  return out;
}

export function Pagination({ page, total, perPage, onChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;

  const pages = buildPages(page, totalPages);
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);

  return (
    <nav className={styles.pager} aria-label="Paginação">
      <div className={styles.info}>
        Exibindo{" "}
        <b>
          {from}–{to}
        </b>{" "}
        de <b>{total}</b> produtos
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.btn}
          disabled={page === 1}
          onClick={() => onChange(page - 1)}
          aria-label="Página anterior"
        >
          <Icon name="chevronLeft" size={16} />
          <span>Anterior</span>
        </button>

        <div className={styles.numbers}>
          {pages.map((p, i) =>
            p === "ellipsis" ? (
              <span key={`e-${i}`} className={styles.ellipsis} aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className={`${styles.num} ${page === p ? styles.active : ""}`}
                onClick={() => onChange(p)}
                aria-current={page === p ? "page" : undefined}
              >
                {p}
              </button>
            ),
          )}
        </div>

        <button
          type="button"
          className={styles.btn}
          disabled={page === totalPages}
          onClick={() => onChange(page + 1)}
          aria-label="Próxima página"
        >
          <span>Próxima</span>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
    </nav>
  );
}

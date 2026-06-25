import Link from "next/link";
import type { LowStockProduct } from "@/lib/data/products";
import { Icon } from "@/components/ui/Icon";
import styles from "./AdminLowStockView.module.css";

export function AdminLowStockView({ products }: { products: LowStockProduct[] }) {
  const zero = products.filter((p) => p.available <= 0).length;

  return (
    <section>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Estoque baixo</h1>
          <p className={styles.sub}>
            {products.length} produto(s) com estoque disponível baixo · {zero} esgotado(s)
          </p>
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.left}>
                Produto
              </th>
              <th scope="col" className={styles.center}>
                Estoque
              </th>
              <th scope="col" className={styles.center}>
                Reservado
              </th>
              <th scope="col" className={styles.center}>
                Disponível
              </th>
              <th scope="col" className={styles.right}>
                Ações
              </th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td className={styles.left}>
                  <span className={styles.name}>{p.name}</span>
                </td>
                <td className={`${styles.center} tnum`}>{p.stock}</td>
                <td className={`${styles.center} tnum`}>{p.reserved}</td>
                <td className={styles.center}>
                  <span
                    className={`${styles.available} ${p.available <= 0 ? styles.availableZero : styles.availableLow} tnum`}
                  >
                    {p.available}
                  </span>
                </td>
                <td className={styles.right}>
                  <div className={styles.actions}>
                    <Link
                      href="/admin/produtos"
                      className={styles.act}
                      aria-label={`Editar ${p.name}`}
                      title="Editar produto"
                    >
                      <Icon name="edit" size={15} />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {products.length === 0 && (
              <tr>
                <td colSpan={5} className={styles.emptyCell}>
                  Tudo certo — nenhum produto com estoque baixo no momento.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

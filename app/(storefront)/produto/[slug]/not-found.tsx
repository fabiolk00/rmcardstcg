import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import styles from "./produto.module.css";

// 404 da rota de produto: slug inexistente cai aqui (page.tsx chama notFound()).
export default function ProdutoNotFound() {
  return (
    <section className={styles.notFound}>
      <h1 className={styles.notFoundTitle}>Produto não encontrado</h1>
      <p className={styles.notFoundText}>
        O produto que você procura não existe mais ou saiu do catálogo.
      </p>
      <Link href="/colecoes" className={styles.notFoundCta}>
        Ver coleção completa <Icon name="arrow" size={16} />
      </Link>
    </section>
  );
}

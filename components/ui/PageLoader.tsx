import { Spinner } from "./Spinner";
import styles from "./PageLoader.module.css";

// Tela de carregamento de rota (usada pelos loading.tsx). Centraliza um spinner
// grande + rotulo enquanto o Server Component da rota nova faz fetch.
export function PageLoader({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <Spinner size={36} label={label} />
      <span className={styles.label}>{label}</span>
    </div>
  );
}

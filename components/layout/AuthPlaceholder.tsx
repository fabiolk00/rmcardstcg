import styles from "./AuthPlaceholder.module.css";

// Exibido nas paginas de auth quando o Clerk nao esta configurado (modo mock).
export function AuthPlaceholder({ mode }: { mode: "entrar" | "criar-conta" }) {
  const title = mode === "entrar" ? "Entrar" : "Criar conta";
  return (
    <div className={styles.box}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.text}>Login indisponível no modo de demonstração.</p>
    </div>
  );
}

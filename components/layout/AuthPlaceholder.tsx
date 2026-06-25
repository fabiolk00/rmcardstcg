import styles from "./AuthPlaceholder.module.css";

// Exibido no painel de formulario quando o Clerk nao esta configurado (modo mock).
// Sem Clerk nao ha cabecalho proprio, entao o heading vem daqui.
export function AuthPlaceholder({ mode }: { mode: "entrar" | "criar-conta" }) {
  const title = mode === "entrar" ? "Bem-vindo de volta." : "Crie sua conta.";
  return (
    <div className={styles.box}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.text}>Login indisponível no modo de demonstração.</p>
      <p className={styles.hint}>Configure as chaves do Clerk para habilitar o acesso.</p>
    </div>
  );
}

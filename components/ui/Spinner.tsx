import type { ReactNode } from "react";
import styles from "./Spinner.module.css";

// Anel giratorio sem lib (contrato secao 4: icones/animacoes inline). A cor vem
// de currentColor; a espessura escala com o tamanho.
export function Spinner({
  size = 16,
  className = "",
  label = "Carregando",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  const border = Math.max(2, Math.round(size / 9));
  return (
    <span
      className={`${styles.spinner} ${className}`}
      style={{ width: size, height: size, borderWidth: border }}
      role="status"
      aria-label={label}
    />
  );
}

// Spinner + texto alinhados — para o estado "ocupado" de um botao
// (ex.: <SpinnerLabel>Enviando…</SpinnerLabel>).
export function SpinnerLabel({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <span className={styles.label}>
      <Spinner size={size} />
      {children}
    </span>
  );
}

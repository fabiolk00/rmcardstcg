import styles from "./Stars.module.css";

/**
 * Estrelas de avaliacao (0–5, arredonda para inteiro) — componente compartilhado
 * entre o card e a pagina de produto. Sem lib de icone (contrato secao 4): SVG
 * inline estilo Feather. `className` permite ao chamador sobrepor cor/layout (o
 * card usa o seu proprio); o default aplica a cor dourada padrao.
 */
export function Stars({
  rating,
  size = 14,
  className,
}: {
  rating: number;
  size?: number;
  className?: string;
}) {
  const rounded = Math.round(rating);
  return (
    <span
      className={className ?? styles.stars}
      role="img"
      aria-label={`Nota ${rating.toFixed(1)} de 5`}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <svg
          key={i}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill={i < rounded ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ))}
    </span>
  );
}

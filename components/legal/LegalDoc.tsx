import styles from "./LegalDoc.module.css";

// Bloco de conteudo: paragrafo (string) ou lista de itens ({ list: [...] }).
export type LegalBlock = string | { list: string[] };

export interface LegalSection {
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDocProps {
  eyebrow: string;
  title: string;
  updated: string;
  lead?: string;
  sections: LegalSection[];
  /** Rodape opcional (ex.: "Todos os direitos reservados."). */
  footer?: string;
}

// Documento legal (Politica de Privacidade / Termos de Uso). Server component,
// conteudo estatico dirigido por dados — sem DB, sem auth. Layout de leitura em
// coluna estreita, tipografia consistente com o resto da vitrine.
export function LegalDoc({ eyebrow, title, updated, lead, sections, footer }: LegalDocProps) {
  return (
    <article className={styles.doc}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.updated}>{updated}</p>
        {lead ? <p className={styles.lead}>{lead}</p> : null}
      </header>

      {sections.map((section) => (
        <section key={section.heading} className={styles.section}>
          <h2>{section.heading}</h2>
          {section.blocks.map((block, i) =>
            typeof block === "string" ? (
              <p key={`${section.heading}-p-${i}`}>{block}</p>
            ) : (
              <ul key={`${section.heading}-ul-${i}`}>
                {block.list.map((item, j) => (
                  <li key={`${section.heading}-li-${i}-${j}`}>{item}</li>
                ))}
              </ul>
            ),
          )}
        </section>
      ))}

      {footer ? <p className={styles.docFooter}>{footer}</p> : null}
    </article>
  );
}

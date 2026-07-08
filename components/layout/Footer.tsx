import Image from "next/image";
import Link from "next/link";
import styles from "./Footer.module.css";

const lojaLinks: { label: string; cat?: string }[] = [
  { label: "Booster Boxes", cat: "Booster Box" },
  { label: "Elite Trainer Boxes", cat: "Elite Trainer Box" },
  { label: "Cartas avulsas", cat: "Single Card" },
  { label: "Acessórios", cat: "Acessórios" },
];

// Paginas legais (rotas em app/(storefront)).
const atendimento: { label: string; href: string }[] = [
  { label: "Política de privacidade", href: "/politica-de-privacidade" },
  { label: "Termos de uso", href: "/termos-de-uso" },
];

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.about}>
          <Image
            src="/logo-rm.png"
            alt="RM Cards"
            width={120}
            height={40}
            className={styles.logo}
          />
          <p className={styles.tagline}>
            Loja especializada em Pokémon TCG. Boosters, ETBs, acessórios e cartas avulsas com
            curadoria e garantia de originalidade.
          </p>
        </div>

        <div className={styles.col}>
          <h4>Loja</h4>
          {lojaLinks.map((l) => (
            <Link
              key={l.label}
              href={l.cat ? `/colecoes?cat=${encodeURIComponent(l.cat)}` : "/colecoes"}
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className={styles.col}>
          <h4>Atendimento</h4>
          {atendimento.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
        </div>
      </div>

      <div className={`container ${styles.bottom}`}>
        <span>© 2026 RM Cards · Pokémon TCG</span>
        <span>Pagamentos · PIX · Cartão</span>
      </div>
    </footer>
  );
}

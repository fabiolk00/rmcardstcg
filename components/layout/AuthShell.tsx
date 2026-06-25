import Image from "next/image";
import Link from "next/link";
import styles from "./AuthShell.module.css";

type Mode = "entrar" | "criar-conta";

// Moldura split-screen das paginas de Entrar / Criar conta (fora do storefront):
// painel esquerdo com abas + formulario (Clerk), painel direito institucional.
// O cabecalho/heading do formulario vem do proprio Clerk (ou do AuthPlaceholder
// no modo mock); aqui cuidamos so das abas, do aviso legal e do painel de marca.
export function AuthShell({ mode, children }: { mode: Mode; children: React.ReactNode }) {
  return (
    <main className={styles.shell}>
      <Link href="/" className={styles.brand} aria-label="RM Cards — início">
        <Image
          src="/logo-rm.png"
          alt="RM Cards"
          width={120}
          height={40}
          className={styles.logo}
          priority
        />
      </Link>

      <div className={styles.card}>
        <section className={styles.formPanel}>
          <div className={styles.formInner}>
            <nav className={styles.tabs} aria-label="Entrar ou criar conta">
              <Link
                href="/entrar"
                className={`${styles.tab} ${mode === "entrar" ? styles.tabActive : ""}`}
                aria-current={mode === "entrar" ? "page" : undefined}
              >
                Entrar
              </Link>
              <Link
                href="/criar-conta"
                className={`${styles.tab} ${mode === "criar-conta" ? styles.tabActive : ""}`}
                aria-current={mode === "criar-conta" ? "page" : undefined}
              >
                Criar conta
              </Link>
            </nav>

            <div className={styles.formSlot}>{children}</div>

            <p className={styles.legal}>
              Ao continuar, você concorda com os Termos de uso e a Política de privacidade da RM
              Cards.
            </p>
          </div>
        </section>

        <aside className={styles.aside}>
          <div className={styles.asideInner}>
            <h2 className={styles.asideTitle}>Sua coleção Pokémon está prestes a evoluir.</h2>
            <p className={styles.asideText}>
              A RM Cards reúne boosters, Elite Trainer Boxes, acessórios e cartas avulsas — tudo com
              curadoria e garantia de originalidade.
            </p>
            <p className={styles.asideText}>
              Acompanhe seus pedidos, aproveite cupons exclusivos e receba com rastreio de envio, do
              nosso estoque até a sua porta.
            </p>
            <p className={styles.asideKicker}>Bora abrir o próximo pack?</p>
          </div>
        </aside>
      </div>

      <footer className={styles.pageFooter}>
        <span>© 2026 RM Cards · Pokémon TCG</span>
        <span className={styles.pageFooterLinks}>
          <span>Política de privacidade</span>
          <span aria-hidden="true">·</span>
          <span>Termos de uso</span>
        </span>
      </footer>
    </main>
  );
}

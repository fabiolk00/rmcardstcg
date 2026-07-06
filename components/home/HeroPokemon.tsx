import Image from "next/image";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import styles from "./HeroPokemon.module.css";

export type HeroMotion = "calmo" | "equilibrado" | "energetico";

export interface HeroCharacter {
  src: string;
  alt: string;
}

// Arte default = sprites "official-artwork" auto-hospedados em /public/hero. Cada
// personagem ocupa um "slot elemental" fixo (agua / fogo / eletrico); a prop
// `characters` troca a arte por fotos de produto ou banner licenciado quando houver.
const DEFAULT_CHARACTERS = {
  water: { src: "/hero/blastoise.png", alt: "Blastoise" },
  fire: { src: "/hero/charizard.png", alt: "Charizard" },
  electric: { src: "/hero/pikachu.png", alt: "Pikachu" },
} satisfies Record<"water" | "fire" | "electric", HeroCharacter>;

export interface HeroPokemonProps {
  /** Velocidade global das animacoes do palco. Default: equilibrado. */
  motion?: HeroMotion;
  /** Sobrescreve a arte dos tres slots elementais (agua / fogo / eletrico). */
  characters?: Partial<typeof DEFAULT_CHARACTERS>;
}

// Pokébola desenhada em SVG inline (sem dependencia externa). Tamanho, posicao,
// timing e opacidade (--ball-op) vem do CSS por bola. Cores reais de produto
// (fora do chrome monocromatico): vermelho/preto/branco.
function Pokeball({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M1 12 A11 11 0 0 1 23 12 Z" fill="#ee1515" />
      <path d="M1 12 A11 11 0 0 0 23 12 Z" fill="#f5f5f5" />
      <rect x="1.3" y="10.6" width="21.4" height="2.8" fill="#1a1a1a" />
      <circle cx="12" cy="12" r="11" fill="none" stroke="#1a1a1a" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="3.4" fill="#f5f5f5" stroke="#1a1a1a" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="1.3" fill="#fff" stroke="#1a1a1a" strokeWidth="0.8" />
    </svg>
  );
}

// O polígono de raio dourado (SVG inline). Tamanho/posicao/delay vem do CSS por
// bolt; o fill usa o token --gold via `.bolt`.
function Bolt({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 22 34" className={className} aria-hidden="true">
      <polygon points="13,0 2,19 9,19 5,34 20,12 11,12" />
    </svg>
  );
}

export function HeroPokemon({ motion = "equilibrado", characters }: HeroPokemonProps) {
  // Merge por slot (não spread) para que um override `undefined` caia no default
  // em vez de zerar o slot — assim `src`/`alt` nunca ficam undefined no render.
  const cast = {
    water: characters?.water ?? DEFAULT_CHARACTERS.water,
    fire: characters?.fire ?? DEFAULT_CHARACTERS.fire,
    electric: characters?.electric ?? DEFAULT_CHARACTERS.electric,
  };

  return (
    <section className={styles.hero} data-motion={motion} aria-label="Coleção em destaque">
      <div className={styles.grid}>
        {/* ===== Coluna esquerda: texto + CTAs + métricas ===== */}
        <div className={styles.copy}>
          <div className={styles.eyebrow}>
            <span className={styles.eyebrowDot} aria-hidden="true" />
            <span className={styles.eyebrowText}>Coleção em destaque · pronta-entrega</span>
          </div>

          <h1 className={styles.title}>{"Gotta collect 'em all."}</h1>

          <p className={styles.lede}>
            Seus parceiros favoritos em cartas originais lacradas. Booster boxes, ETBs e singles
            raras com entrega rápida em todo o Brasil.
          </p>

          <div className={styles.ctas}>
            <Link href="/colecoes" className={styles.btnPrimary}>
              Ver coleção completa
              <Icon name="arrow" size={18} />
            </Link>
            <Link
              href={`/colecoes?cat=${encodeURIComponent("Booster Box")}`}
              className={styles.btnGhost}
            >
              Booster boxes
            </Link>
          </div>

          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={`${styles.statValue} tnum`}>
                4.9
                <span aria-hidden="true">★</span>
              </span>
              <span className={styles.statLabel}>Avaliação média</span>
            </div>
            <span className={styles.statDivider} aria-hidden="true" />
            <div className={styles.stat}>
              <span className={`${styles.statValue} tnum`}>48h</span>
              <span className={styles.statLabel}>Envio médio</span>
            </div>
            <span className={styles.statDivider} aria-hidden="true" />
            <div className={styles.stat}>
              <span className={`${styles.statValue} tnum`}>100%</span>
              <span className={styles.statLabel}>Originais lacradas</span>
            </div>
          </div>
        </div>

        {/* ===== Coluna direita: palco animado (decorativo, oculto em ≤880px) ===== */}
        <div className={styles.stageWrap} aria-hidden="true">
          <div className={styles.stage}>
            {/* pokébolas caindo do céu, atrás de tudo */}
            <div className={styles.balls}>
              {[
                styles.ball1,
                styles.ball2,
                styles.ball3,
                styles.ball4,
                styles.ball5,
                styles.ball6,
                styles.ball7,
              ].map((cls, i) => (
                <Pokeball key={i} className={`${styles.ball} ${cls}`} />
              ))}
            </div>

            {/* halos girando ao fundo */}
            <span className={`${styles.halo} ${styles.haloOuter}`} />
            <span className={`${styles.halo} ${styles.haloInner}`} />

            {/* sparks de ambiente */}
            {[styles.spark1, styles.spark2, styles.spark3].map((cls, i) => (
              <span key={i} className={`${styles.spark} ${cls}`} />
            ))}

            {/* ----- Esquerda: Água ----- */}
            <div className={`${styles.char} ${styles.charLeft}`}>
              <span className={styles.shadow} />
              <div className={styles.bob}>
                <div className={styles.art}>
                  <div className={styles.fx}>
                    {/* ripple #1 usa só o delay base (0); #2/#3 trazem o override */}
                    {[undefined, styles.ripple2, styles.ripple3].map((cls, i) => (
                      <span key={i} className={cls ? `${styles.ripple} ${cls}` : styles.ripple} />
                    ))}
                    {[
                      styles.bubble1,
                      styles.bubble2,
                      styles.bubble3,
                      styles.bubble4,
                      styles.bubble5,
                      styles.bubble6,
                    ].map((cls, i) => (
                      <span key={i} className={`${styles.bubble} ${cls}`} />
                    ))}
                  </div>
                  <Image
                    src={cast.water.src}
                    alt={cast.water.alt}
                    width={193}
                    height={193}
                    priority
                    className={styles.img}
                  />
                </div>
              </div>
            </div>

            {/* ----- Centro: Fogo (herói) ----- */}
            <div className={`${styles.char} ${styles.charCenter}`}>
              <span className={styles.shadow} />
              <div className={styles.bob}>
                <div className={styles.art}>
                  <span className={styles.glow} />
                  <Image
                    src={cast.fire.src}
                    alt={cast.fire.alt}
                    width={324}
                    height={324}
                    priority
                    className={styles.img}
                  />
                  <div className={styles.fx}>
                    {[
                      styles.ember1,
                      styles.ember2,
                      styles.ember3,
                      styles.ember4,
                      styles.ember5,
                      styles.ember6,
                      styles.ember7,
                      styles.ember8,
                    ].map((cls, i) => (
                      <span key={i} className={`${styles.ember} ${cls}`} />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* ----- Direita: Elétrico ----- */}
            <div className={`${styles.char} ${styles.charRight}`}>
              <span className={styles.shadow} />
              <div className={styles.bob}>
                <div className={styles.art}>
                  <div className={`${styles.fx} ${styles.fxElectric}`}>
                    <span className={styles.flash} />
                    {[
                      styles.bolt1,
                      styles.bolt2,
                      styles.bolt3,
                      styles.bolt4,
                      styles.bolt5,
                      styles.bolt6,
                    ].map((cls, i) => (
                      <Bolt key={i} className={`${styles.bolt} ${cls}`} />
                    ))}
                  </div>
                  <Image
                    src={cast.electric.src}
                    alt={cast.electric.alt}
                    width={210}
                    height={210}
                    priority
                    className={styles.img}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

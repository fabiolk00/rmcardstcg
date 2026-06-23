"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import styles from "./ProductGallery.module.css";

/**
 * Galeria da pagina de produto — imagem principal + miniaturas + zoom (lightbox).
 *
 * Aceita um array de imagens e degrada para a unica `imageUrl` que o schema guarda
 * hoje: com 1 imagem, esconde a faixa de miniaturas mas mantem o clique-para-zoom.
 * Sem dependencia externa (constraint: features core sem libs) — lightbox em React
 * puro + CSS, acessivel por teclado (Esc fecha, setas navegam) e mobile-first.
 */
export function ProductGallery({
  images,
  alt,
  badge,
}: {
  images: string[];
  alt: string;
  badge?: string | null;
}) {
  const list = images.length > 0 ? images : ["/products/placeholder.svg"];
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);
  const multiple = list.length > 1;

  const go = useCallback(
    (dir: number) => setActive((i) => (i + dir + list.length) % list.length),
    [list.length],
  );

  // Teclado no lightbox: Esc fecha; setas navegam. Trava o scroll do body enquanto
  // aberto. Cleanup restaura tudo (inclusive ao desmontar com o lightbox aberto).
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(false);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [zoom, go]);

  return (
    <div className={styles.gallery}>
      <button
        type="button"
        className={styles.main}
        onClick={() => setZoom(true)}
        aria-label="Ampliar imagem"
      >
        {badge && <span className={styles.badge}>{badge}</span>}
        <Image
          src={list[active]}
          alt={alt}
          fill
          priority
          sizes="(max-width: 900px) 100vw, 50vw"
          className={styles.img}
        />
        <span className={styles.zoomHint} aria-hidden="true">
          <Icon name="search" size={16} />
        </span>
      </button>

      {multiple && (
        <div className={styles.thumbs} role="tablist" aria-label="Miniaturas">
          {list.map((src, i) => (
            <button
              key={`${src}-${i}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-label={`Imagem ${i + 1} de ${list.length}`}
              className={`${styles.thumb} ${i === active ? styles.thumbActive : ""}`}
              onClick={() => setActive(i)}
            >
              <Image src={src} alt="" fill sizes="80px" className={styles.thumbImg} />
            </button>
          ))}
        </div>
      )}

      {zoom && (
        <div
          className={styles.lightbox}
          role="dialog"
          aria-modal="true"
          aria-label={`Imagem ampliada: ${alt}`}
        >
          {/* Backdrop clicavel como BOTAO (nao div com onClick) — fecha ao clicar
              fora da imagem, sem disparar regras de a11y de elemento estatico. */}
          <button
            type="button"
            className={styles.backdrop}
            aria-label="Fechar imagem ampliada"
            onClick={() => setZoom(false)}
          />

          <button
            type="button"
            className={styles.close}
            aria-label="Fechar"
            autoFocus
            onClick={() => setZoom(false)}
          >
            <Icon name="x" size={22} />
          </button>

          {multiple && (
            <button
              type="button"
              className={`${styles.nav} ${styles.prev}`}
              aria-label="Imagem anterior"
              onClick={() => go(-1)}
            >
              <Icon name="chevronLeft" size={26} />
            </button>
          )}

          <div className={styles.lightboxStage}>
            <Image src={list[active]} alt={alt} fill sizes="100vw" className={styles.lightboxImg} />
          </div>

          {multiple && (
            <button
              type="button"
              className={`${styles.nav} ${styles.next}`}
              aria-label="Proxima imagem"
              onClick={() => go(1)}
            >
              <Icon name="chevronRight" size={26} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

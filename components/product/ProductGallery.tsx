"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
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
  // Gatilho do zoom (p/ devolver o foco ao fechar) e raiz do dialog (p/ trap de Tab).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (dir: number) => setActive((i) => (i + dir + list.length) % list.length),
    [list.length],
  );

  // Teclado no lightbox: Esc fecha; setas navegam; Tab fica preso no dialog (modal).
  // Trava o scroll do body enquanto aberto. Cleanup restaura o scroll E devolve o
  // foco ao gatilho (padrao de dialog acessivel).
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setZoom(false);
        return;
      }
      if (e.key === "ArrowLeft") {
        go(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        go(1);
        return;
      }
      if (e.key === "Tab") {
        // Focus trap: cicla o Tab entre os botoes focaveis do dialog (aria-modal).
        const root = lightboxRef.current;
        if (!root) return;
        const focusables = Array.from(root.querySelectorAll<HTMLElement>("button"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeEl = document.activeElement;
        if (!root.contains(activeEl)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && activeEl === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const trigger = triggerRef.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Devolve o foco ao gatilho ao fechar (no-op se ja desmontou na navegacao).
      trigger?.focus();
    };
  }, [zoom, go]);

  return (
    <div className={styles.gallery}>
      <button
        ref={triggerRef}
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
          ref={lightboxRef}
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

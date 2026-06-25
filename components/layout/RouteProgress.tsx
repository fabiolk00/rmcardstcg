"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import styles from "./RouteProgress.module.css";

/**
 * Barra de progresso global de navegacao (sem libs). Da "sensacao de
 * carregamento" em qualquer clique que troque de rota — loja, auth e admin.
 *
 * Como funciona:
 *  - Um listener de clique (fase de captura) detecta cliques em <a> que vao
 *    navegar (mesma origem, sem modificadores, sem target=_blank) e inicia a
 *    barra na hora — feedback antes mesmo do React renderizar a rota nova.
 *  - popstate (voltar/avancar do navegador) tambem inicia.
 *  - A barra completa quando pathname+searchParams mudam (rota nova montada).
 *  - Um timeout de seguranca finaliza caso a navegacao seja cancelada (ex.:
 *    clique no mesmo link) e o pathname nunca mude — evita barra "presa".
 */
export function RouteProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams}`;

  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);

  const running = useRef(false);
  const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearTimers() {
    if (trickle.current) clearInterval(trickle.current);
    if (safety.current) clearTimeout(safety.current);
    if (done.current) clearTimeout(done.current);
    trickle.current = safety.current = done.current = null;
  }

  function start() {
    if (running.current) return;
    running.current = true;
    clearTimers();
    setVisible(true);
    setProgress(8);
    // sobe ate ~90% e desacelera, esperando a rota montar
    trickle.current = setInterval(() => {
      setProgress((p) => (p < 90 ? p + (90 - p) * 0.12 : p));
    }, 240);
    // seguranca: navegacao cancelada nao deixa a barra presa
    safety.current = setTimeout(finish, 8000);
  }

  function finish() {
    if (!running.current) return;
    running.current = false;
    clearTimers();
    setProgress(100);
    done.current = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 280);
  }

  // Completa quando a rota efetivamente muda (no mount inicial e um no-op).
  useEffect(() => {
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const anchor = (e.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return; // externo
      if (url.href === window.location.href) return; // mesma URL → nao navega
      // ancora pura na mesma pagina (#secao) nao e navegacao
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search &&
        url.hash
      ) {
        return;
      }
      start();
    }

    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", start);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", start);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!visible) return null;

  return (
    <div className={styles.root} aria-hidden="true">
      <div className={styles.bar} style={{ width: `${progress}%` }} />
      <span className={styles.spinner} />
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import styles from "./AdminProfileCard.module.css";

type Props = {
  /** Email do admin exibido no card (truncado com ellipsis). */
  email: string;
  /** Cargo/UserRole exibido como chip (ou texto, ver roleStyle). */
  roleLabel: string;
  /** Tweak de aparencia do cargo: pilula (default) ou texto simples. */
  roleStyle?: "chip" | "plain";
  /** Acao "Configuracoes" (ex.: abrir perfil do Clerk). Ausente -> item no-op. */
  onSettings?: () => void;
  /** Acao "Sair" (ex.: signOut do Clerk). Ausente -> cai para um link "/". */
  onSignOut?: () => void;
  /** Destino do item "Colecoes". */
  colecoesHref?: string;
  /**
   * Presente -> o PRIMEIRO item vira o link "Conta" (painel do cliente) no
   * lugar de "Configuracoes". O admin nao passa e mantem o menu original.
   */
  contaHref?: string;
};

/**
 * Card de perfil do admin (rodape da sidebar) que abre um dropdown PARA CIMA com
 * Configuracoes / Colecoes / Sair. Substitui o antigo "Ver loja + avatar".
 *
 * Estado unico `open`; fecha ao clicar fora (pointerdown no documento + checagem de
 * ref), Esc, ou ao selecionar um item. Itens de menu sao classes CSS sem background
 * INLINE de proposito: assim a regra `:hover` vence por especificidade (estilo inline
 * venceria o hover de classe — bug do prototipo original).
 */
export function AdminProfileCard({
  email,
  roleLabel,
  roleStyle = "chip",
  onSettings,
  onSignOut,
  colecoesHref = "/colecoes",
  contaHref,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // Fecha ao clicar fora (pointerdown) ou Esc. So escuta enquanto aberto.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Move o foco para o 1o item ao abrir (acessibilidade do menu). Via query no
  // menu (nao ref fixo): o 1o item varia — "Conta" (link) ou "Configuracoes".
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Navegacao por setas entre os itens do menu.
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown" ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const close = () => setOpen(false);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {open && (
        <div
          className={styles.menu}
          role="menu"
          id={menuId}
          aria-label="Menu do perfil"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {contaHref ? (
            <Link href={contaHref} role="menuitem" className={styles.item} onClick={close}>
              <Icon name="user" size={17} />
              <span>Conta</span>
            </Link>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              onClick={() => {
                close();
                onSettings?.();
              }}
            >
              <Icon name="settings" size={17} />
              <span>Configurações</span>
            </button>
          )}

          <Link href={colecoesHref} role="menuitem" className={styles.item} onClick={close}>
            <Icon name="layers" size={17} />
            <span>Coleções</span>
          </Link>

          <div className={styles.divider} role="separator" />

          {onSignOut ? (
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${styles.danger}`}
              onClick={() => {
                close();
                onSignOut();
              }}
            >
              <Icon name="logout" size={17} />
              <span>Sair</span>
            </button>
          ) : (
            <Link
              href="/"
              role="menuitem"
              className={`${styles.item} ${styles.danger}`}
              onClick={close}
            >
              <Icon name="logout" size={17} />
              <span>Sair</span>
            </Link>
          )}
        </div>
      )}

      <button
        type="button"
        className={styles.card}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        ref={triggerRef}
      >
        <span className={styles.avatar}>
          <Icon name="user" size={19} />
        </span>
        <span className={styles.meta}>
          <span className={styles.email}>{email}</span>
          <span className={roleStyle === "plain" ? styles.rolePlain : styles.roleChip}>
            {roleLabel}
          </span>
        </span>
        <span className={styles.chevron}>
          <Icon name={open ? "chevronDown" : "chevronUp"} size={16} />
        </span>
      </button>
    </div>
  );
}

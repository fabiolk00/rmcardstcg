"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { REVIEWS_ENABLED } from "@/lib/config/features";
import { Icon, type IconName } from "@/components/ui/Icon";
import styles from "./AdminNav.module.css";

// Avaliacoes ocultas do frontend em 2026-07-06 (flag NEXT_PUBLIC_REVIEWS_ENABLED):
// o item so aparece no menu quando a flag esta ligada (a rota tambem 404 quando off).
const ITEMS: { href: string; label: string; icon: IconName }[] = [
  { href: "/admin/produtos", label: "Produtos", icon: "grid" },
  { href: "/admin/categorias", label: "Categorias", icon: "layers" },
  { href: "/admin/estoque", label: "Estoque Baixo", icon: "box" },
  { href: "/admin/pedidos", label: "Pedidos", icon: "receipt" },
  ...(REVIEWS_ENABLED
    ? [{ href: "/admin/avaliacoes", label: "Avaliações", icon: "star" as IconName }]
    : []),
  { href: "/admin/cupons", label: "Cupons", icon: "archive" },
  { href: "/admin/usuarios", label: "Usuários", icon: "user" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="Menu do painel">
      {ITEMS.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${styles.item} ${active ? styles.active : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon name={item.icon} size={19} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

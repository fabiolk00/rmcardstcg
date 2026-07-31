"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import styles from "./ClienteNav.module.css";

const ITEMS: { href: string; label: string; icon: IconName; exact?: boolean }[] = [
  { href: "/painel/conta", label: "Conta", icon: "user" },
  { href: "/painel/colecoes", label: "Coleções", icon: "grid" },
  { href: "/painel/pedidos", label: "Meus Pedidos", icon: "receipt" },
  { href: "/painel/carrinho", label: "Carrinho", icon: "box" },
  // Escape do painel p/ a loja publica (home) — nao e destino do painel, entao
  // "active" e por igualdade exata (pathname nunca e "/" aqui dentro).
  { href: "/", label: "Voltar à Loja", icon: "cart", exact: true },
];

export function ClienteNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="Menu do painel">
      {ITEMS.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
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

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import styles from "./ClienteNav.module.css";

const ITEMS: { href: string; label: string; icon: IconName }[] = [
  { href: "/painel/conta", label: "Conta", icon: "user" },
  { href: "/painel/colecoes", label: "Coleções", icon: "grid" },
  { href: "/painel/pedidos", label: "Meus Pedidos", icon: "receipt" },
  { href: "/painel/carrinho", label: "Carrinho", icon: "box" },
];

export function ClienteNav() {
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

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ui/Icon";
import styles from "./AdminNav.module.css";

const ITEMS: { href: string; label: string; icon: IconName }[] = [
  { href: "/admin/produtos", label: "Produtos", icon: "package" },
  { href: "/admin/pedidos", label: "Pedidos", icon: "receipt" },
  { href: "/admin/cupons", label: "Cupons", icon: "archive" },
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
            <Icon name={item.icon} size={16} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

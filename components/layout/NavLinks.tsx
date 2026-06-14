"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Topbar.module.css";

const ITEMS = [
  { href: "/", label: "Início" },
  { href: "/colecoes", label: "Coleções" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className={styles.nav}>
      {ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${styles.link} ${active ? styles.active : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

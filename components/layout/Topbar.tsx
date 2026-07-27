import Image from "next/image";
import Link from "next/link";
import { NavLinks } from "./NavLinks";
import { AuthControls } from "./AuthControls";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import styles from "./Topbar.module.css";

export function Topbar() {
  return (
    <header className={styles.topbar}>
      <div className={`container ${styles.inner}`}>
        <Link href="/" className={styles.brand}>
          <Image
            src="/logo-rm.png"
            alt="RM Cards"
            width={120}
            height={40}
            className={styles.logo}
            priority
          />
        </Link>

        <NavLinks />

        <div className={styles.spacer} />

        <a
          href="https://www.instagram.com/rmcardstcg"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Instagram"
          className={styles.instagram}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <linearGradient
                id="instagramGradient"
                x1="0"
                y1="24"
                x2="24"
                y2="0"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="#f9ce34" />
                <stop offset="0.3" stopColor="#ee2a7b" />
                <stop offset="0.6" stopColor="#6228d7" />
                <stop offset="1" stopColor="#6228d7" />
              </linearGradient>
            </defs>
            <rect
              x="2"
              y="2"
              width="20"
              height="20"
              rx="5"
              fill="url(#instagramGradient)"
            />
            <circle
              cx="12"
              cy="12"
              r="4.5"
              stroke="white"
              strokeWidth="1.6"
            />
            <circle cx="17.2" cy="6.8" r="1.1" fill="white" />
          </svg>
        </a>

        {isClerkConfigured() ? (
          <AuthControls />
        ) : (
          <div className={styles.auth}>
            <Link href="/entrar" className={styles.btnGhost}>
              Entrar
            </Link>
            <Link href="/criar-conta" className={styles.btnDark}>
              Criar conta
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}

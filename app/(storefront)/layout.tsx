import { redirectAdminAwayFromStorefront } from "@/lib/auth/resolveViewer";
import { CartProvider } from "@/lib/cart/CartContext";
import { Topbar } from "@/components/layout/Topbar";
import { Footer } from "@/components/layout/Footer";
import { WhatsAppFab } from "@/components/layout/WhatsAppFab";
import styles from "./storefront.module.css";

export default async function StorefrontLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Admin logado nao ve NENHUMA pagina da vitrine — vai direto para /admin. No
  // layout para cobrir todo o grupo (inclusive produto/[slug] e paginas legais,
  // que nao tem guard proprio). Cliente/anon seguem; o espelho do cliente e feito
  // por-pagina (redirectLoggedInFromStorefront).
  await redirectAdminAwayFromStorefront();

  return (
    <CartProvider>
      <div className={styles.shell}>
        <Topbar />
        <main className={`container page ${styles.main}`}>{children}</main>
        <Footer />
        <WhatsAppFab />
      </div>
    </CartProvider>
  );
}

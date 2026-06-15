import { CartProvider } from "@/lib/cart/CartContext";
import { Topbar } from "@/components/layout/Topbar";
import { Footer } from "@/components/layout/Footer";
import { WhatsAppFab } from "@/components/layout/WhatsAppFab";
import styles from "./storefront.module.css";

export default function StorefrontLayout({ children }: Readonly<{ children: React.ReactNode }>) {
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

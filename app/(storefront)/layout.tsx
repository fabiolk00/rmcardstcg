import { CartProvider } from "@/lib/cart/CartContext";
import { Topbar } from "@/components/layout/Topbar";
import { Footer } from "@/components/layout/Footer";
import { WhatsAppFab } from "@/components/layout/WhatsAppFab";
import styles from "./storefront.module.css";

// Guard de admin NAO fica mais aqui (era global pro grupo inteiro): a home ("/")
// e destino deliberado da logo da sidebar do painel/admin ("voltar a loja"), entao
// precisa ficar aberta pra admin tambem. As paginas que ainda devem barrar admin
// chamam redirectAdminAwayFromStorefront() (produto/[slug], termos, privacidade)
// ou ja chamam redirectLoggedInFromStorefront (colecoes/carrinho/checkout/
// minhas-compras, que redireciona admin E cliente).
export default async function StorefrontLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
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

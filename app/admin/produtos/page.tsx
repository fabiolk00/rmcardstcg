import { getProducts } from "@/lib/data/products";
import { AdminProductsView } from "@/components/admin/AdminProductsView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminProdutosPage() {
  const products = await getProducts();
  return <AdminProductsView products={products} />;
}

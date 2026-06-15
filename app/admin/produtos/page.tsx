import { getProducts } from "@/lib/data/products";
import { AdminProductsView } from "@/components/admin/AdminProductsView";

export default async function AdminProdutosPage() {
  const products = await getProducts();
  return <AdminProductsView products={products} />;
}

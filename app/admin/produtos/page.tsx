import { getCategoryNames } from "@/lib/data/categories";
import { getProducts } from "@/lib/data/products";
import { AdminProductsView } from "@/components/admin/AdminProductsView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminProdutosPage() {
  // Categorias da tabela (fonte de verdade): alimentam o dropdown do form e o filtro.
  const [products, categories] = await Promise.all([getProducts(), getCategoryNames()]);
  return <AdminProductsView products={products} categories={categories} />;
}

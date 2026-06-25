import { getLowStockProducts } from "@/lib/data/products";
import { AdminLowStockView } from "@/components/admin/AdminLowStockView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminEstoquePage() {
  const products = await getLowStockProducts();
  return <AdminLowStockView products={products} />;
}

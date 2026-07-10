import { getCategories } from "@/lib/data/categories";
import { AdminCategoriesView } from "@/components/admin/AdminCategoriesView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminCategoriasPage() {
  const categories = await getCategories();
  return <AdminCategoriesView categories={categories} />;
}

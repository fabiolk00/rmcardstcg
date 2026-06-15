import { getOrders } from "@/lib/data/orders";
import { AdminOrdersView } from "@/components/admin/AdminOrdersView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminPedidosPage() {
  const orders = await getOrders();
  return <AdminOrdersView orders={orders} />;
}

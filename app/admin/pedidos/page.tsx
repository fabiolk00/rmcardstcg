import { getOrders } from "@/lib/data/orders";
import { AdminOrdersView } from "@/components/admin/AdminOrdersView";

export default async function AdminPedidosPage() {
  const orders = await getOrders();
  return <AdminOrdersView orders={orders} />;
}

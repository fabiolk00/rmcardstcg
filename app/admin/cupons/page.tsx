import { getCoupons } from "@/lib/data/coupons";
import { AdminCouponsView } from "@/components/admin/AdminCouponsView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminCuponsPage() {
  const coupons = await getCoupons();
  return <AdminCouponsView coupons={coupons} />;
}

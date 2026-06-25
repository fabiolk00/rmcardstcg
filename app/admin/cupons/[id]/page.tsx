import { notFound } from "next/navigation";

import { getCouponById, getCouponRedemptions } from "@/lib/data/coupons";
import { AdminCouponUsageView } from "@/components/admin/AdminCouponUsageView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminCouponUsagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const coupon = await getCouponById(id);
  if (!coupon) notFound();

  const redemptions = await getCouponRedemptions(id);
  return <AdminCouponUsageView coupon={coupon} redemptions={redemptions} />;
}

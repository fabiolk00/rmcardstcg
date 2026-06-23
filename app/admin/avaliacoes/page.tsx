import { getPendingReviews } from "@/lib/data/reviews";
import { AdminReviewsView } from "@/components/admin/AdminReviewsView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminAvaliacoesPage() {
  const reviews = await getPendingReviews();
  return <AdminReviewsView reviews={reviews} />;
}

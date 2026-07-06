import { notFound } from "next/navigation";

import { REVIEWS_ENABLED } from "@/lib/config/features";
import { getPendingReviews } from "@/lib/data/reviews";
import { AdminReviewsView } from "@/components/admin/AdminReviewsView";

// Admin precisa de dados ao vivo do banco (sem snapshot estatico no build).
export const dynamic = "force-dynamic";

export default async function AdminAvaliacoesPage() {
  // Avaliacoes ocultas do frontend em 2026-07-06 (flag NEXT_PUBLIC_REVIEWS_ENABLED).
  // Dados historicos preservados em public.reviews; a rota de gestao fica 404 (sem
  // superficie de UI) enquanto a flag estiver off, mas o codigo permanece p/ reativar.
  if (!REVIEWS_ENABLED) notFound();

  const reviews = await getPendingReviews();
  return <AdminReviewsView reviews={reviews} />;
}

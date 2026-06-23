"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { getProductBySlug } from "@/lib/data/products";
import { submitReview } from "@/lib/data/reviews";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { sendReviewModerationEmail } from "@/lib/services/resend";

/**
 * Server action de submissao de avaliacao (vitrine).
 *
 * Validacao em camadas: aqui resolve o produto pelo SLUG no server (nunca confia
 * num productId do client), revalida auth + rate limit, e delega para submitReview
 * (camada de servico, que revalida rating/tamanhos). A review nasce 'pending' ate
 * a moderacao do admin.
 */

export type SubmitReviewActionResult = { ok: true } | { ok: false; error: string };

async function clientKey(userId: string): Promise<string> {
  if (userId !== "guest") return `u:${userId}`;
  try {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim();
    if (ip) return `ip:${ip}`;
  } catch {
    // fora de escopo de request
  }
  return "anon";
}

export async function submitReviewAction(input: {
  slug: string;
  rating: number;
  title?: string | null;
  body: string;
  authorName: string;
}): Promise<SubmitReviewActionResult> {
  // Auth: com Clerk exige login; mock-first cai em "guest".
  let userId = "guest";
  if (isClerkConfigured()) {
    const { userId: clerkId } = await auth();
    if (!clerkId) return { ok: false, error: "Faça login para avaliar." };
    userId = clerkId;
  }

  const limited = await checkRateLimit(`review-submit:${await clientKey(userId)}`, {
    limit: 5,
    windowMs: 60_000,
  });
  if (!limited.allowed) return { ok: false, error: "Muitas tentativas. Aguarde um instante." };

  // Resolve o produto pelo slug no SERVER (anti-tamper de productId). Inativo
  // (soft-delete) nao e avaliavel — mensagem alinhada com submitReview.
  const product = await getProductBySlug(input.slug);
  if (!product || !product.isActive) {
    return { ok: false, error: "Este produto não está disponível para avaliação." };
  }

  const res = await submitReview({
    productId: product.id,
    userId,
    authorName: input.authorName,
    rating: input.rating,
    title: input.title ?? null,
    body: input.body,
  });
  if (!res.ok) return { ok: false, error: res.error };

  // Notifica o admin para moderar (mock-first: no-op sem Resend/ADMIN_EMAILS).
  await sendReviewModerationEmail({
    productName: product.name,
    authorName: res.review.authorName,
    rating: res.review.rating,
    body: res.review.body,
  });

  // Reflete "em moderação" na pagina (a review aprovada aparece em visita futura;
  // a pagina e force-dynamic, entao nao precisa de revalidacao para a lista).
  revalidatePath(`/produto/${input.slug}`);
  return { ok: true };
}

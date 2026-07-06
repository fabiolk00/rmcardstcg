/**
 * Feature flags de runtime — resolvidas do ambiente no boot do bundle (build/deploy),
 * nao por request. Como sao lidas em Server e Client Components, usam o prefixo
 * NEXT_PUBLIC_ (inlinado pelo Next nos dois bundles).
 *
 * reviews (avaliacoes de produto): OCULTAS do frontend em 2026-07-06. A feature
 * continua no codigo (componentes, camada de dados, admin) e os dados historicos +
 * RLS permanecem intactos em public.reviews para auditoria — apenas nao ha superficie
 * de UI enquanto a flag estiver desligada. Para reexibir, defina
 * NEXT_PUBLIC_REVIEWS_ENABLED=true. Default: OCULTO (qualquer valor != "true").
 */

/** Pura (testavel): reviews so ligam com a string exata "true". */
export function reviewsEnabled(value: string | undefined): boolean {
  return value === "true";
}

export const REVIEWS_ENABLED = reviewsEnabled(process.env.NEXT_PUBLIC_REVIEWS_ENABLED);

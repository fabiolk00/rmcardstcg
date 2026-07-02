-- =============================================================================
-- customer_profiles — perfil/endereco do cliente (painel /painel/conta).
--
-- Uma linha por usuario Clerk (UNIQUE clerk_user_id), upsert pela camada
-- lib/data/profile.ts. clerk_user_id por TEXTO (como orders/reviews/coupon_
-- redemptions): sem FK real ao espelho de users — o perfil pode nascer antes
-- do webhook de sync (e "guest" existe no modo mock-first).
--
-- cep guarda 8 digitos SEM mascara (formatacao NNNNN-NNN e da UI); state e a
-- UF em 2 letras. Campos de endereco alem do checkout (number/complement/
-- district) sao opcionais: o prefill do checkout concatena street+number
-- (+complement) — o perfil e um SUPERSET do form do checkout.
--
-- Aditiva e segura para producao: apenas tabela nova.
-- =============================================================================
CREATE TABLE "customer_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clerk_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT NOT NULL,
    "cpf_cnpj" TEXT,
    "cep" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "number" TEXT,
    "complement" TEXT,
    "district" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- Um perfil por usuario: o save e um UPSERT por clerk_user_id.
CREATE UNIQUE INDEX "customer_profiles_clerk_user_id_key" ON "customer_profiles"("clerk_user_id");

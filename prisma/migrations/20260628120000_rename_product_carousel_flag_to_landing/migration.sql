-- =============================================================================
-- Renomeia a flag de destaque do produto: is_carousel -> is_landing.
--
-- A coluna controla se o produto entra na vitrine "Em destaque" da landing
-- (selecao em lib/data/carousel.ts; ainda chamada de "carrossel" no codigo). O
-- dominio passou a expor o campo como `isLanding`, entao a coluna acompanha o
-- nome. RENAME COLUMN e metadata-only no Postgres (sem reescrita de tabela, sem
-- lock pesado) e PRESERVA os dados existentes — apenas troca o nome.
-- =============================================================================

-- AlterTable
ALTER TABLE "products" RENAME COLUMN "is_carousel" TO "is_landing";

-- =============================================================================
-- Flag de carrossel no produto (admin -> landing).
--
-- Adiciona products.is_carousel: o admin marca quais produtos aparecem na secao
-- "Em destaque" da home. Aditiva e segura para producao (Supabase): coluna com
-- DEFAULT constante e metadata-only no Postgres 11+ (sem reescrita de tabela, sem
-- lock pesado). Opt-in explicito: DEFAULT false => nenhum produto entra no
-- carrossel ate ser marcado; a landing tem fallback para nao ficar vazia nesse
-- meio-tempo. Sem CHECK e sem indice (boolean de baixa cardinalidade).
-- =============================================================================

-- AlterTable
ALTER TABLE "products" ADD COLUMN "is_carousel" BOOLEAN NOT NULL DEFAULT false;

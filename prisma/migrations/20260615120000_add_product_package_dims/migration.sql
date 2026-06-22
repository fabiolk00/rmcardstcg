-- =============================================================================
-- Medidas de pacote para frete no produto (peso + dimensoes).
--
-- Adiciona products.weight_grams / length_cm / width_cm / height_cm para a cotacao
-- de frete (SuperFrete) usar as medidas REAIS por produto (com margem de embalagem),
-- distinguindo, p.ex., Booster Box 18 de 36. Aditiva e segura para producao: colunas
-- com DEFAULT constante sao metadata-only no Postgres 11+ (sem reescrita, sem lock
-- pesado). 0 = "nao definido" -> a cotacao usa o default da categoria
-- (lib/services/superfrete/dimensions). Peso em GRAMAS e dimensoes em CM, sempre Int.
-- =============================================================================

-- AlterTable
ALTER TABLE "products"
  ADD COLUMN "weight_grams" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "length_cm" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "width_cm" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "height_cm" INTEGER NOT NULL DEFAULT 0;

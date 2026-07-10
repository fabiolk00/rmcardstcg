-- Seed do catalogo de categorias com o conjunto CANONICO (CATEGORIES em
-- lib/data/types.ts). A partir daqui a tabela `categories` e a FONTE DE VERDADE
-- das categorias atribuiveis a produto (acoplamento por nome: produtos validam
-- contra ela; o form/filtro do admin leem dela). Cobre 100% das categorias que os
-- produtos ja usam, pois a validacao anterior so aceitava estes 9 valores.
--
-- Idempotente: ON CONFLICT (name) DO NOTHING — reaplicar nao duplica nem sobrescreve
-- categorias criadas/editadas a mao pelo admin. `id` via gen_random_uuid() (a coluna
-- nao tem default no banco); `updated_at` explicito (coluna sem default).
INSERT INTO "categories" ("id", "name", "updated_at")
VALUES
  (gen_random_uuid(), 'Booster Box', now()),
  (gen_random_uuid(), 'Elite Trainer Box', now()),
  (gen_random_uuid(), 'Booster Pack', now()),
  (gen_random_uuid(), 'Blister Triplo', now()),
  (gen_random_uuid(), 'Blister Quadruplo', now()),
  (gen_random_uuid(), 'Coleção Especial', now()),
  (gen_random_uuid(), 'Tin', now()),
  (gen_random_uuid(), 'Acessórios', now()),
  (gen_random_uuid(), 'Single Card', now())
ON CONFLICT ("name") DO NOTHING;

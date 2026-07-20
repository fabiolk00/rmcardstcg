-- Emissao de etiqueta pelo admin: campos que o provedor EXIGE e que o pedido
-- ainda nao guardava, + o store de idempotencia em banco.
--
-- Nullable de proposito: pedidos legados foram criados antes de o checkout
-- coletar numero/bairro/documento. Para esses, o admin completa na hora de
-- emitir; pedidos novos ja nascem com os campos preenchidos.
ALTER TABLE "orders"
  ADD COLUMN "address_number" TEXT,
  ADD COLUMN "address_complement" TEXT,
  ADD COLUMN "address_district" TEXT,
  ADD COLUMN "customer_document" TEXT,
  ADD COLUMN "shipping_service_code" INTEGER;

-- Uma linha por pedido (upsert). Esta tabela E o store de idempotencia do
-- modulo de etiqueta: sem ela o controle era em memoria e um deploy no meio de
-- um retry podia pagar a mesma etiqueta duas vezes.
CREATE TABLE "shipping_labels" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "order_id"      INTEGER      NOT NULL,
  "external_ref"  TEXT         NOT NULL,
  "superfrete_id" TEXT         NOT NULL,
  "status"        TEXT         NOT NULL,
  "paid"          BOOLEAN      NOT NULL DEFAULT false,
  "cost_cents"    INTEGER      NOT NULL DEFAULT 0,
  "label_url"     TEXT,
  "tracking_code" TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "shipping_labels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shipping_labels_order_id_key" ON "shipping_labels" ("order_id");
CREATE UNIQUE INDEX "shipping_labels_external_ref_key" ON "shipping_labels" ("external_ref");

ALTER TABLE "shipping_labels"
  ADD CONSTRAINT "shipping_labels_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

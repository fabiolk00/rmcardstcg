-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "asaas_customer_id" TEXT,
ADD COLUMN     "asaas_payment_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "orders_asaas_payment_id_key" ON "orders"("asaas_payment_id");

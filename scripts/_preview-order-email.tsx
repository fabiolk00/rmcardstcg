/**
 * Preview DEV do template transacional (emails/OrderEmail.tsx): renderiza os
 * dois kinds (paid/created) para HTML estatico com um pedido de exemplo, p/
 * inspecao visual no navegador. NAO envia nada e NAO toca banco.
 *
 *   pnpm exec tsx scripts/_preview-order-email.tsx [outDir]
 *
 * outDir default: diretorio temporario do SO.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { render } from "@react-email/components";

import OrderEmail from "../emails/OrderEmail";
import type { Order } from "../lib/data/types";

const SAMPLE_ORDER: Order = {
  id: "#10421",
  userId: "user_preview",
  customerName: "Fábio",
  customerEmail: "cliente@example.com",
  customerPhone: "41999999999",
  customerDocument: null,
  address: { cep: "81310160", street: "Rua das Araucárias, 123", number: "100", complement: null, district: "Centro", city: "Curitiba", state: "PR" },
  items: [
    {
      productId: "p1",
      productName: "Booster Box — Escarlate e Violeta 151",
      quantity: 1,
      unitPriceCents: 89990,
    },
    { productId: "p2", productName: "Sleeves Ultra Pro (100 un.)", quantity: 2, unitPriceCents: 4990 },
  ],
  subtotalCents: 99970,
  discountCents: 5000,
  couponCode: "BEMVINDO10",
  couponDiscountCents: 9497,
  shippingCents: 0,
  totalCents: 85473, // 99970 - 5000 - 9497 + 0
  shippingService: "PAC",
  shippingServiceCode: null,
  shippingDays: "5 a 8 dias úteis",
  paymentStatus: "paid",
  paymentMethod: "pix",
  shippingStatus: "pending",
  trackingCode: null,
  shippingCarrier: null,
  internalNote: null,
  shippingLabel: null,
  createdAt: new Date().toISOString(),
};

async function main() {
  const outDir = process.argv[2] ?? path.join(os.tmpdir(), "rmcards-email-preview");
  mkdirSync(outDir, { recursive: true });
  for (const kind of ["paid", "created"] as const) {
    const html = await render(OrderEmail({ order: SAMPLE_ORDER, kind }));
    const file = path.join(outDir, `order-email-${kind}.html`);
    writeFileSync(file, html);
    console.log(`renderizado: ${file} (${html.length} bytes)`);
  }
}

void main();

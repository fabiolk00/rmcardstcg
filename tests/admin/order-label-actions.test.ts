import { describe, expect, it } from "vitest";

import { orderLabelState } from "@/lib/admin/orderLabelActions";
import type { Order, OrderShippingLabel } from "@/lib/data/types";

/**
 * Regra dos botoes de etiqueta na LINHA do pedido (/admin/pedidos). Pura porque
 * a tela exige login de admin e nao tem cobertura e2e — e porque errar aqui
 * custa dinheiro: emitir debita a carteira, e um pedido sem CPF/numero so
 * falharia depois, na chamada ao provedor.
 */
function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "#42",
    userId: "user_1",
    customerName: "Maria",
    customerEmail: "maria@exemplo.com",
    customerPhone: "41999990000",
    customerDocument: "52998224725",
    address: {
      cep: "80010000",
      street: "Rua XV de Novembro",
      number: "285",
      complement: null,
      district: "Centro",
      city: "Curitiba",
      state: "PR",
    },
    items: [],
    subtotalCents: 25_000,
    discountCents: 0,
    couponCode: null,
    couponDiscountCents: 0,
    shippingCents: 1934,
    totalCents: 26_934,
    shippingService: "LOGGI",
    shippingServiceCode: 31,
    shippingDays: "2 dias úteis",
    paymentStatus: "paid",
    paymentMethod: "pix",
    shippingStatus: "pending",
    trackingCode: null,
    shippingCarrier: null,
    internalNote: null,
    shippingLabel: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

const label = (overrides: Partial<OrderShippingLabel> = {}): OrderShippingLabel => ({
  superFreteId: "SF123",
  status: "released",
  paid: true,
  costCents: 1934,
  labelUrl: null,
  trackingCode: "LG123456789BR",
  ...overrides,
});

describe("orderLabelState", () => {
  it("pedido pago e completo: oferece emitir", () => {
    expect(orderLabelState(order())).toEqual({ kind: "issue", disabled: false });
  });

  it("com etiqueta viva: passa a oferecer imprimir/cancelar, com o rastreio", () => {
    expect(orderLabelState(order({ shippingLabel: label() }))).toEqual({
      kind: "manage",
      trackingCode: "LG123456789BR",
    });
  });

  it("etiqueta cancelada volta a permitir emitir (envio novo no provedor)", () => {
    expect(orderLabelState(order({ shippingLabel: label({ status: "canceled" }) }))).toEqual({
      kind: "issue",
      disabled: false,
    });
  });

  it.each([
    ["pendente de pagamento", { paymentStatus: "pending" as const }, "Só para pedido pago"],
    ["sem CPF/CNPJ (legado)", { customerDocument: null }, "Pedido sem CPF/CNPJ"],
    ["sem modalidade cotada", { shippingServiceCode: null }, "Pedido sem modalidade cotada"],
  ])("%s: botão desabilitado dizendo o motivo", (_l, overrides, reason) => {
    const state = orderLabelState(order(overrides));
    expect(state).toEqual({ kind: "issue", disabled: true, reason });
  });

  it("endereço legado sem número ou bairro: desabilitado com o motivo", () => {
    const semNumero = order({
      address: { ...order().address, number: null },
    });
    const semBairro = order({
      address: { ...order().address, district: null },
    });
    expect(orderLabelState(semNumero)).toMatchObject({ reason: "Endereço sem número/bairro" });
    expect(orderLabelState(semBairro)).toMatchObject({ reason: "Endereço sem número/bairro" });
  });

  it.each(["delivered", "cancelled"] as const)("envio %s: nenhum botão de etiqueta", (status) => {
    expect(orderLabelState(order({ shippingStatus: status }))).toEqual({ kind: "none" });
  });

  it("envio já entregue COM etiqueta ainda permite imprimir a segunda via", () => {
    expect(
      orderLabelState(order({ shippingStatus: "delivered", shippingLabel: label() })),
    ).toMatchObject({ kind: "manage" });
  });
});

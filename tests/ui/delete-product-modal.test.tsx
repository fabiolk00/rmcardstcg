// @vitest-environment jsdom
//
// Prova de interacao do DeleteProductModal (components/admin/DeleteProductModal). A
// exclusao e PERMANENTE (hard-delete), entao a confirmacao exige um passo explicito de
// ciencia: o botao "Excluir" so habilita depois de marcar o checkbox. Cobre tambem o
// caminho de erro do servidor (ex.: produto ja vendido -> in_use), que o modal exibe
// como alerta SEM fechar, e o cancelamento. Usa so matchers nativos do vitest (o repo
// nao configura @testing-library/jest-dom) — asserts via propriedades cruas do DOM.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeleteProductModal } from "@/components/admin/DeleteProductModal";
import type { Product } from "@/lib/data/types";

afterEach(cleanup);

const PRODUCT: Product = {
  id: "p-1",
  slug: "produto-teste",
  name: "Produto Teste",
  category: "Booster Box",
  sku: "SKU-1",
  priceCents: 1000,
  discountPct: 0,
  rating: 0,
  reviewCount: 0,
  stock: 5,
  available: 5,
  isActive: true,
  isLanding: false,
  badge: null,
  imageUrl: "/products/placeholder.svg",
  description: "",
  weightGrams: 0,
  lengthCm: 0,
  widthCm: 0,
  heightCm: 0,
  createdAt: "",
};

function renderModal(
  onConfirm: () => Promise<string | null> = vi.fn(async () => null),
  onClose = vi.fn(),
) {
  render(<DeleteProductModal product={PRODUCT} onClose={onClose} onConfirm={onConfirm} />);
  return { onConfirm, onClose };
}

function deleteButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Excluir" }) as HTMLButtonElement;
}

describe("DeleteProductModal (admin/DeleteProductModal)", () => {
  it("botao Excluir comeca DESABILITADO ate marcar a ciencia", () => {
    renderModal();
    expect(deleteButton().disabled).toBe(true);
  });

  it("marca a ciencia, clica Excluir e chama onConfirm (exclusao permanente)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => null);
    renderModal(onConfirm);

    await user.click(screen.getByRole("checkbox"));
    const btn = deleteButton();
    expect(btn.disabled).toBe(false);
    await user.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("exibe o erro do servidor (ex.: produto ja vendido) sem fechar", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn(async () => "Produto já foi vendido e não pode ser excluído.");
    renderModal(onConfirm, onClose);

    await user.click(screen.getByRole("checkbox"));
    await user.click(deleteButton());

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/já foi vendido/i));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("NAO chama onConfirm se clicar Excluir sem marcar a ciencia", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => null);
    renderModal(onConfirm);

    // botao desabilitado: o clique nao dispara a acao.
    await user.click(deleteButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("fecha pelo botao Cancelar", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

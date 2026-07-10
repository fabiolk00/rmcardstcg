// @vitest-environment jsdom
//
// Prova de interacao do Modal reusavel (components/ui/Modal). O comportamento
// critico: clicar FORA (no overlay/scrim) NAO fecha o modal — so o X, o Esc e
// os botoes internos (ex.: Cancelar) fecham. Evita fechamento acidental em
// formularios/acoes criticas do admin.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Modal } from "@/components/ui/Modal";

afterEach(cleanup);

function renderModal(onClose = vi.fn()) {
  render(
    <Modal
      title="Confirmar acao"
      onClose={onClose}
      footer={
        <button type="button" onClick={onClose}>
          Cancelar
        </button>
      }
    >
      <p>Conteudo do modal</p>
    </Modal>,
  );
  return onClose;
}

describe("Modal (ui/Modal)", () => {
  it("NAO fecha ao clicar no overlay (scrim)", () => {
    const onClose = renderModal();
    // O scrim e o wrapper com role="presentation" que envolve o dialog.
    const scrim = document.querySelector('[role="presentation"]');
    expect(scrim).not.toBeNull();
    fireEvent.click(scrim as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("NAO fecha ao clicar dentro do conteudo do dialog", () => {
    const onClose = renderModal();
    fireEvent.click(screen.getByText("Conteudo do modal"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("fecha pelo botao X (aria-label Fechar)", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();
    await user.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fecha pelo botao Cancelar do footer", async () => {
    const user = userEvent.setup();
    const onClose = renderModal();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fecha ao pressionar Esc (acessibilidade mantida)", () => {
    const onClose = renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

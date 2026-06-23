"use client";

/**
 * Botao "Imprimir / Salvar PDF" — usa o dialogo de impressao do navegador
 * (window.print()), cuja opcao "Salvar como PDF" gera o comprovante em PDF sem
 * nenhuma dependencia externa (constraint: sem pdfkit). A folha de impressao
 * (globals.css @media print) isola o bloco do recibo.
 */
export function PrintButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.print()}>
      Imprimir / Salvar PDF
    </button>
  );
}

/**
 * Formatacao de moeda em pt-BR (BRL).
 *
 * Convencao do projeto: dinheiro sempre em inteiro de centavos (ver secao 4 do
 * contrato). A formatacao pt-BR vive so na UI.
 *
 * @param cents valor inteiro em centavos (ex.: 123456)
 * @returns string formatada (ex.: "R$ 1.234,56")
 */
export function formatBRL(cents: number): string {
  const value = cents / 100;
  // O ICU insere um espaco nao-quebravel (NBSP/narrow-NBSP) apos "R$".
  // O unico whitespace da saida e esse separador, entao normalizamos
  // qualquer \s para espaco simples e a saida fica deterministica.
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  })
    .format(value)
    .replace(/\s/g, " ");
}

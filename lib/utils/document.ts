/**
 * Mascara de CPF/CNPJ para EXIBICAO. O dominio guarda so digitos (e o provedor
 * de frete exige assim); a mascara vive na borda de apresentacao.
 *
 * Tamanho fora de 11/14 devolve o valor CRU em vez de inventar uma mascara —
 * um documento invalido precisa parecer invalido para o admin, nao ganhar
 * pontuacao que sugira que esta correto.
 */
export function formatDocument(doc: string | null | undefined): string | null {
  if (doc == null) return null;
  const d = doc.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) {
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }
  return doc;
}

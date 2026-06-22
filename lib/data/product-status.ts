/**
 * Acoes de status (inativar / reativar) de uma linha de produto no admin.
 *
 * Decisao de UI PURA (sem React, sem DOM) — testavel isolada, no espirito de
 * selectCarouselProducts / finalPriceCents. A tela de produtos renderiza os DOIS
 * icones lado a lado (inativar + reativar) e DESABILITA o que nao se aplica ao
 * estado atual: um produto ATIVO so pode ser inativado; um INATIVO so reativado.
 * Assim o admin sempre ve para onde pode levar a linha e nunca dispara a
 * transicao que seria um no-op (setProductActive ja e idempotente no servidor,
 * mas desabilitar evita o round-trip inutil e deixa o estado obvio).
 */

/** Transicao de status que um botao da linha dispara. */
export type ProductStatusKind = "inactivate" | "reactivate";

export interface ProductStatusAction {
  /** Transicao que este botao dispara. */
  kind: ProductStatusKind;
  /** Nome do icone (contrato do componente Icon). */
  icon: "power" | "rotate";
  /** Habilitado so quando a transicao muda de fato o estado (evita no-op). */
  enabled: boolean;
  /** Verbo curto p/ title/tooltip e composicao do aria-label. */
  verb: string;
}

/**
 * Devolve SEMPRE as duas acoes, na ordem fixa [inativar, reativar], para um
 * layout estavel de icones. `enabled` e mutuamente exclusivo: exatamente uma das
 * duas e `true` para qualquer valor de `isActive`.
 */
export function productStatusActions(
  isActive: boolean,
): [ProductStatusAction, ProductStatusAction] {
  return [
    { kind: "inactivate", icon: "power", enabled: isActive, verb: "Inativar" },
    { kind: "reactivate", icon: "rotate", enabled: !isActive, verb: "Reativar" },
  ];
}

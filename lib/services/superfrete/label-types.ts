/**
 * CONTRATO CONGELADO (SYNC 0) — modulo de etiqueta SuperFrete.
 *
 * Este arquivo e a interface compartilhada entre:
 *  - Agente A (implementacao real em lib/services/superfrete/labels.ts)
 *  - Agente B (harness + stub em tests/shipping/labels-harness/)
 *
 * NAO EDITE sem reconciliacao explicita entre os dois lados (regra do programa).
 * O mapeamento provedor <-> contrato e as formas REAIS capturadas estao em
 * lib/services/superfrete/LABEL-CONTRACT.md.
 *
 * Convencoes do dominio: dinheiro em CENTAVOS Int; peso em GRAMAS; dimensoes em
 * CM (a conversao p/ reais-float e kg-float do provedor e responsabilidade da
 * implementacao, nunca do chamador).
 */

/** Endereco completo de remetente/destinatario. */
export type LabelAddress = {
  name: string;
  /**
   * CPF/CNPJ (so digitos). OBRIGATORIO no destinatario — o provedor rejeita
   * sem ele (400 {errors:{"to.document":[...]}}, capturado no sandbox).
   */
  document: string;
  /** Logradouro (rua/avenida). */
  address: string;
  number: string;
  complement?: string;
  district: string;
  city: string;
  /** UF, 2 letras (ex.: "PR"). */
  stateAbbr: string;
  /** CEP; a implementacao normaliza para 8 digitos. */
  postalCode: string;
  email?: string;
  phone?: string;
};

/** Item para a DECLARACAO DE CONTEUDO (envio sem nota fiscal — non_commercial). */
export type LabelItem = {
  name: string;
  quantity: number;
  /** Valor unitario da mercadoria em centavos Int. */
  unitPriceCents: number;
};

/** Pacote consolidado — DEVE ser o mesmo da cotacao exibida ao cliente. */
export type LabelPackage = {
  weightGrams: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
};

export type CreateLabelInput = {
  /**
   * Referencia do pedido INTERNO (ex.: "pedido-123"). Base da idempotencia:
   * o mesmo externalRef NUNCA gera duas etiquetas (dedupe + retomada), e vira
   * a tag do envio no painel SuperFrete (options.tags).
   */
  externalRef: string;
  /** Modalidade escolhida na cotacao (1=PAC, 2=SEDEX). */
  serviceCode: number;
  from: LabelAddress;
  to: LabelAddress;
  /** >= 1 item; alimenta a declaracao de conteudo. */
  items: LabelItem[];
  pkg: LabelPackage;
  /**
   * Valor declarado (centavos) — o MESMO da cotacao (clamp piso/teto de
   * lib/services/superfrete/config.getInsuranceLimits ja aplicado; a
   * implementacao re-clampa defensivamente). 0 = sem seguro.
   */
  declaredValueCents: number;
};

/** Status do ciclo de vida (mapeado do provedor). */
export type LabelStatus = "pending" | "released" | "posted" | "delivered" | "canceled";

export type CreatedLabel = {
  superFreteId: string;
  /** null enquanto o provedor nao emite o rastreio (fica vazio ate a postagem). */
  trackingCode: string | null;
  status: LabelStatus;
  /** Custo da etiqueta em centavos Int. */
  priceCents: number;
  /** true quando o resultado veio de dedupe/retomada (retry idempotente). */
  reused: boolean;
};

export type PrintFormat = "A4" | "A6";

export type PrintedLabel = {
  /** URL do artefato imprimivel (PDF). */
  url: string;
  format: PrintFormat;
};

export type CanceledLabel = {
  canceled: boolean;
  /** true se o cancelamento gera estorno p/ carteira (etiqueta ja paga). */
  refunded: boolean;
};

export type WalletBalance = {
  balanceCents: number;
  /** Franquia de envios do sandbox (limits.shipments*), null em producao/ausente. */
  shipmentsUsed: number | null;
  shipmentsAvailable: number | null;
};

export type LabelInfo = {
  superFreteId: string;
  status: LabelStatus;
  trackingCode: string | null;
  priceCents: number | null;
  /** Valor declarado registrado NO ENVIO (prova do seguro fim-a-fim). */
  declaredValueCents: number | null;
  serviceCode: number;
  /** URL de impressao ja emitida pelo provedor (order/info.print.url), se houver. */
  printUrl: string | null;
  toPostalCode: string;
  toName: string;
  toDocument: string;
  fromPostalCode: string;
  pkg: LabelPackage;
};

/** Erros tipados do modulo (a implementacao estende Error com estes codes). */
export type LabelErrorCode =
  | "validation" // input invalido — falha LOCAL, sem chamada/estado no provedor
  | "insufficient_balance" // saldo/franquia insuficiente para o checkout
  | "unavailable" // provedor recusou (CEP nao atendido, modalidade indisponivel...)
  | "provider"; // erro HTTP/contrato do provedor

/**
 * A interface que o Agente A implementa e o Agente B consome (stub identico).
 * createLabel = cart + checkout (fluxo completo), IDEMPOTENTE por externalRef:
 * retry apos falha parcial RETOMA (nao duplica; checkout 409 = ja pago = sucesso).
 */
export interface LabelModule {
  createLabel(input: CreateLabelInput): Promise<CreatedLabel>;
  printLabel(superFreteId: string, format?: PrintFormat): Promise<PrintedLabel>;
  cancelLabel(superFreteId: string, reason?: string): Promise<CanceledLabel>;
  getWalletBalance(): Promise<WalletBalance>;
  getLabelInfo(superFreteId: string): Promise<LabelInfo>;
}

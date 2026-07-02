import { getInsuranceLimits } from "@/lib/services/superfrete/config";
import type {
  CanceledLabel,
  CreateLabelInput,
  CreatedLabel,
  LabelErrorCode,
  LabelInfo,
  LabelModule,
  LabelStatus,
  PrintFormat,
  PrintedLabel,
  WalletBalance,
} from "@/lib/services/superfrete/label-types";

/**
 * STUB deterministico da interface LabelModule — fiel ao CONTRATO congelado
 * (lib/services/superfrete/LABEL-CONTRACT.md), NAO a implementacao do Agente A.
 *
 * Semantica coberta (mesmos casos de borda do contrato):
 *  - validacao LOCAL (document/CEP/peso/dimensoes/items) falha rapido com code
 *    "validation" SEM criar estado (nenhum envio meio-criado);
 *  - idempotencia por externalRef: retry devolve o MESMO superFreteId com
 *    reused=true e sem segunda cobranca (equivale ao 409 "ja pago" tratado
 *    como sucesso idempotente);
 *  - checkout consome SALDO da carteira fake (confirmado no portao real: a
 *    "franquia" limits.shipments_available NAO paga etiqueta — com saldo 0 o
 *    provedor devolve 409 "Sem saldo na carteira!"); sem saldo lanca
 *    "insufficient_balance" sem criar nada; shipments_* e contador inerte;
 *  - cancel devolve refunded conforme pago e ESTORNA a carteira; cancelar de
 *    novo e no-op tolerante (canceled=true, refunded=false, sem lancar);
 *  - tracking SEMPRE null (nunca simula postagem — igual ao sandbox antes do
 *    despacho fisico); printUrl fake carrega ?format= como o provedor real.
 *
 * Dinheiro em centavos Int em todo o estado (convencao do dominio). Nenhuma
 * rede: tudo em memoria, puro e deterministico (id derivado do externalRef).
 */

/** Erro tipado do stub — mesmo shape estrutural (code) que a implementacao real. */
export class SuperFreteLabelError extends Error {
  readonly code: LabelErrorCode;

  constructor(message: string, code: LabelErrorCode) {
    super(message);
    this.name = "SuperFreteLabelError";
    this.code = code;
  }
}

const onlyDigits = (s: string) => s.replace(/\D/g, "");

// Limites locais do contrato (caso de borda 7): acima disso e validation LOCAL.
const MAX_WEIGHT_GRAMS = 30_000;
const MAX_DIM_CM = 200;

// Modelo de preco fake, deterministico e monotono: base por modalidade + peso +
// ad valorem de 1% do valor declarado (divisao unica de centavos Int).
const BASE_PRICE_CENTS: Record<number, number> = { 1: 1990, 2: 3490 };

function fakePriceCents(input: CreateLabelInput, declaredCents: number): number {
  const base = BASE_PRICE_CENTS[input.serviceCode] ?? 2990;
  return base + Math.round(input.pkg.weightGrams / 10) + Math.round(declaredCents / 100);
}

/** Re-clamp defensivo do valor declarado (mesma regra da cotacao; 0 = sem seguro). */
function clampDeclared(cents: number): number {
  if (cents <= 0) return 0;
  const { minCents, maxCents } = getInsuranceLimits();
  return Math.min(Math.max(cents, minCents), maxCents);
}

/** Validacao LOCAL (contrato, casos 1/2/7/8): lanca "validation" sem tocar estado. */
function validateInput(input: CreateLabelInput): void {
  const fail = (msg: string): never => {
    throw new SuperFreteLabelError(msg, "validation");
  };
  if (!input.externalRef.trim()) fail("externalRef obrigatorio.");
  if (input.serviceCode !== 1 && input.serviceCode !== 2) fail("serviceCode desconhecido.");
  const toDoc = onlyDigits(input.to.document ?? "");
  if (toDoc.length !== 11 && toDoc.length !== 14) {
    fail("Campo CPF/CNPJ do destinatario e obrigatorio.");
  }
  if (onlyDigits(input.from.postalCode).length !== 8) fail("CEP de origem invalido.");
  if (onlyDigits(input.to.postalCode).length !== 8) fail("CEP de destino invalido.");
  if (input.items.length === 0) fail("Envio precisa de ao menos 1 item declarado.");
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      fail("Quantidade de item invalida.");
    }
    if (!Number.isInteger(item.unitPriceCents) || item.unitPriceCents <= 0) {
      fail("Preco unitario de item invalido.");
    }
  }
  const { weightGrams, heightCm, widthCm, lengthCm } = input.pkg;
  if (!Number.isInteger(weightGrams) || weightGrams <= 0 || weightGrams > MAX_WEIGHT_GRAMS) {
    fail("Peso do pacote invalido (limite de 30 kg).");
  }
  for (const dim of [heightCm, widthCm, lengthCm]) {
    if (!Number.isInteger(dim) || dim <= 0 || dim > MAX_DIM_CM) {
      fail("Dimensao do pacote implausivel.");
    }
  }
  if (!Number.isInteger(input.declaredValueCents) || input.declaredValueCents < 0) {
    fail("Valor declarado invalido.");
  }
}

type StubRecord = {
  superFreteId: string;
  input: CreateLabelInput;
  declaredValueCents: number;
  priceCents: number;
  status: LabelStatus;
  printUrl: string;
};

export type StubOptions = {
  /**
   * Saldo inicial da carteira fake (centavos Int). Default generoso (R$ 1.000)
   * — SO saldo paga etiqueta (achado do portao); passe 0 p/ o caso de abort.
   */
  balanceCents?: number;
  /** Contador shipments_available (INERTE — nao paga etiqueta). Default 5. */
  shipmentsAvailable?: number;
};

/** Fotografia do estado interno — SO para asserts dos testes do motor. */
export type StubSnapshot = {
  created: number;
  paidActive: number;
  canceled: number;
  ids: string[];
};

export type StubLabelModule = LabelModule & { inspect(): StubSnapshot };

/** Cria um LabelModule fake com carteira configuravel (p/ insufficient_balance). */
export function makeStub(opts?: StubOptions): StubLabelModule {
  let balanceCents = opts?.balanceCents ?? 100_000;
  const shipmentsRemaining = opts?.shipmentsAvailable ?? 5;
  const shipmentsUsed = 0;
  const byRef = new Map<string, StubRecord>();
  const byId = new Map<string, StubRecord>();

  const mustFind = (superFreteId: string): StubRecord => {
    const rec = byId.get(superFreteId);
    if (!rec) throw new SuperFreteLabelError("Envio desconhecido no provedor.", "provider");
    return rec;
  };

  return {
    async createLabel(input: CreateLabelInput): Promise<CreatedLabel> {
      validateInput(input);

      // Idempotencia por externalRef ANTES da cobranca: retry nunca duplica nem
      // cobra de novo (e o "409 logico": pagamento repetido = sucesso idempotente).
      const existing = byRef.get(input.externalRef);
      if (existing) {
        return {
          superFreteId: existing.superFreteId,
          trackingCode: null,
          status: existing.status,
          priceCents: existing.priceCents,
          reused: true,
        };
      }

      const declaredValueCents = clampDeclared(input.declaredValueCents);
      const priceCents = fakePriceCents(input, declaredValueCents);

      // Checkout fake: SO saldo paga (achado do portao — franquia e inerte).
      if (balanceCents < priceCents) {
        throw new SuperFreteLabelError(
          "Sem saldo na carteira! Recarregue para emitir a etiqueta.",
          "insufficient_balance",
        );
      }
      balanceCents -= priceCents;

      const superFreteId = `stub-${input.externalRef}`;
      const record: StubRecord = {
        superFreteId,
        input,
        declaredValueCents,
        priceCents,
        // Pago na hora (createLabel = cart + checkout): pending -> released.
        status: "released",
        printUrl: `https://stub.superfrete.local/tag/print/${superFreteId}?format=A4`,
      };
      byRef.set(input.externalRef, record);
      byId.set(superFreteId, record);

      return { superFreteId, trackingCode: null, status: record.status, priceCents, reused: false };
    },

    async printLabel(superFreteId: string, format: PrintFormat = "A4"): Promise<PrintedLabel> {
      const rec = mustFind(superFreteId);
      if (rec.status === "canceled") {
        throw new SuperFreteLabelError("Etiqueta cancelada nao imprime.", "provider");
      }
      return {
        url: `https://stub.superfrete.local/tag/print/${superFreteId}?format=${format}`,
        format,
      };
    },

    async cancelLabel(superFreteId: string): Promise<CanceledLabel> {
      const rec = mustFind(superFreteId);
      // Cancelar de novo: no-op tolerante (caso 9 do contrato), sem duplo estorno.
      if (rec.status === "canceled") return { canceled: true, refunded: false };
      const paga = rec.status !== "pending";
      rec.status = "canceled";
      if (paga) balanceCents += rec.priceCents; // estorno p/ carteira (so saldo)
      return { canceled: true, refunded: paga };
    },

    async getWalletBalance(): Promise<WalletBalance> {
      return { balanceCents, shipmentsUsed, shipmentsAvailable: shipmentsRemaining };
    },

    async getLabelInfo(superFreteId: string): Promise<LabelInfo> {
      const rec = mustFind(superFreteId);
      return {
        superFreteId,
        status: rec.status,
        // NUNCA simula postagem: rastreio fica null ate o despacho fisico real.
        trackingCode: null,
        priceCents: rec.priceCents,
        declaredValueCents: rec.declaredValueCents,
        serviceCode: rec.input.serviceCode,
        printUrl: rec.printUrl,
        toPostalCode: onlyDigits(rec.input.to.postalCode),
        toName: rec.input.to.name,
        toDocument: onlyDigits(rec.input.to.document),
        fromPostalCode: onlyDigits(rec.input.from.postalCode),
        pkg: { ...rec.input.pkg },
      };
    },

    inspect(): StubSnapshot {
      const all = [...byId.values()];
      return {
        created: all.length,
        paidActive: all.filter((r) => r.status !== "canceled" && r.status !== "pending").length,
        canceled: all.filter((r) => r.status === "canceled").length,
        ids: all.map((r) => r.superFreteId),
      };
    },
  };
}

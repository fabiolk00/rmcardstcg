import type { CreateLabelInput, LabelAddress, LabelPackage } from "@/lib/services/superfrete/label-types";
import type { PackageDims } from "@/lib/services/superfrete/dimensions";
import { declaredValueCents } from "@/lib/services/superfrete/quote";
import type { CarrierId } from "@/lib/data/carriers";

/**
 * Monta e VALIDA o pedido de etiqueta a partir de um pedido da loja — puro, sem
 * banco e sem rede, para ser testavel direto.
 *
 * A validacao acontece aqui (e nao so dentro do modulo de etiqueta) porque as
 * mensagens precisam ser acionaveis para o ADMIN: "falta o numero do endereco"
 * resolve-se editando o pedido; um 400 do provedor com `to.number` nao.
 */

/** Linha do pedido ja com as medidas efetivas do produto resolvidas. */
export type LabelDraftItem = {
  name: string;
  quantity: number;
  unitPriceCents: number;
  pkg: PackageDims;
};

/** Pedido, na forma minima que a etiqueta precisa. */
export type LabelDraftOrder = {
  id: number;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerDocument: string | null;
  address: {
    cep: string;
    street: string;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string;
    state: string;
  };
  shippingServiceCode: number | null;
};

export type LabelDraft =
  | { ok: true; input: CreateLabelInput }
  | { ok: false; error: string; field: string };

const digits = (s: string | null | undefined) => (typeof s === "string" ? s.replace(/\D/g, "") : "");
const text = (s: string | null | undefined) => (typeof s === "string" ? s.trim() : "");

/**
 * Consolida as linhas do pedido em UM pacote — que e o que a etiqueta declara.
 *
 * Regra: peso SOMA; largura e comprimento sao o MAIOR entre os itens; altura
 * SOMA (empilhamento). E a aproximacao conservadora do que o lojista realmente
 * faz ao embalar, e casa com a cubagem que o provedor calculou na cotacao. Se o
 * pacote real sair menor, a transportadora reconfere e a diferenca volta; se
 * sair maior, ela cobra a mais — por isso nunca subestimamos aqui.
 */
export function consolidatePackage(items: LabelDraftItem[]): LabelPackage {
  return items.reduce<LabelPackage>(
    (acc, item) => ({
      weightGrams: acc.weightGrams + item.pkg.weightGrams * item.quantity,
      heightCm: acc.heightCm + item.pkg.heightCm * item.quantity,
      widthCm: Math.max(acc.widthCm, item.pkg.widthCm),
      lengthCm: Math.max(acc.lengthCm, item.pkg.lengthCm),
    }),
    { weightGrams: 0, heightCm: 0, widthCm: 0, lengthCm: 0 },
  );
}

/** Transportador (nosso id de rastreio) a partir do codigo de modalidade do provedor. */
export function carrierForServiceCode(serviceCode: number): CarrierId {
  if (serviceCode === 31) return "loggi";
  if (serviceCode === 3) return "jadlog";
  if (serviceCode === 1 || serviceCode === 2) return "correios";
  return "outro";
}

export function buildLabelDraft(args: {
  order: LabelDraftOrder;
  sender: LabelAddress;
  items: LabelDraftItem[];
}): LabelDraft {
  const { order, sender, items } = args;

  if (order.shippingServiceCode == null) {
    return {
      ok: false,
      field: "shippingServiceCode",
      error:
        "Este pedido não guardou a modalidade de frete escolhida (é anterior à emissão de etiqueta). " +
        "Emita a etiqueta pelo painel do SuperFrete ou refaça a cotação.",
    };
  }
  if (items.length === 0) {
    return { ok: false, field: "items", error: "O pedido não tem itens para declarar." };
  }

  const document = digits(order.customerDocument);
  if (document.length !== 11 && document.length !== 14) {
    return {
      ok: false,
      field: "customerDocument",
      error: "Falta o CPF/CNPJ do cliente — a transportadora exige para emitir a etiqueta.",
    };
  }
  const postalCode = digits(order.address.cep);
  if (postalCode.length !== 8) {
    return { ok: false, field: "cep", error: "O CEP do pedido não tem 8 dígitos." };
  }
  if (text(order.address.street).length === 0) {
    return { ok: false, field: "street", error: "Falta a rua no endereço de entrega." };
  }
  if (text(order.address.number).length === 0) {
    return {
      ok: false,
      field: "number",
      error: "Falta o número do endereço — a transportadora não aceita etiqueta sem ele.",
    };
  }
  if (text(order.address.district).length === 0) {
    return {
      ok: false,
      field: "district",
      error: "Falta o bairro do endereço — a transportadora não aceita etiqueta sem ele.",
    };
  }
  if (text(order.address.city).length === 0) {
    return { ok: false, field: "city", error: "Falta a cidade no endereço de entrega." };
  }
  if (!/^[A-Za-z]{2}$/.test(text(order.address.state))) {
    return { ok: false, field: "state", error: "UF inválida no endereço de entrega." };
  }

  const pkg = consolidatePackage(items);
  if (pkg.weightGrams <= 0) {
    return {
      ok: false,
      field: "pkg",
      error: "Os produtos deste pedido estão sem peso cadastrado. Preencha as medidas no produto.",
    };
  }

  return {
    ok: true,
    input: {
      externalRef: `pedido-${order.id}`,
      serviceCode: order.shippingServiceCode,
      from: sender,
      to: {
        name: text(order.customerName),
        document,
        address: text(order.address.street),
        number: text(order.address.number),
        complement: text(order.address.complement) || undefined,
        district: text(order.address.district),
        city: text(order.address.city),
        stateAbbr: text(order.address.state).toUpperCase(),
        postalCode,
        email: text(order.customerEmail) || undefined,
        phone: digits(order.customerPhone) || undefined,
      },
      items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
      })),
      pkg,
      // MESMO valor declarado da cotacao (piso/teto do provedor ja aplicados):
      // declarar diferente muda o preco e quebra a conta "cotado == pago".
      declaredValueCents: declaredValueCents(
        items.map((i) => ({ quantity: i.quantity, pkg: i.pkg, unitPriceCents: i.unitPriceCents })),
      ),
    },
  };
}

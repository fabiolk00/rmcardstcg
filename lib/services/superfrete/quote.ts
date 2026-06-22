import { getSuperFreteConfig, isSuperFreteConfigured } from "./config";
import { superFreteFetch } from "./client";
import type { PackageDims } from "./dimensions";

/**
 * Cotacao de frete via SuperFrete (POST /api/v0/calculator).
 *
 * Mock-first: sem o ambiente configurado (ou CEP/itens invalidos) devolve [] — o
 * chamador cai no frete flat (lib/cart/shipping). Manda a lista de `products` (um por
 * linha do carrinho, com as medidas EFETIVAS do produto — ver effectivePackage), entao
 * a CUBAGEM (consolidacao do pacote) e feita pelo SuperFrete.
 */

// 1=PAC, 2=SEDEX (17=Mini Envios, 3=Jadlog, 31=Loggi disponiveis se quiser ampliar).
const SHIPPING_SERVICES = "1,2";

/** Uma linha do carrinho para cotacao: quantidade + medidas do pacote. */
export type QuoteItem = { quantity: number; pkg: PackageDims };

export type ShippingOption = {
  /** Codigo do servico no SuperFrete (1=PAC, 2=SEDEX, ...). 0 = fallback flat. */
  serviceCode: number;
  name: string;
  priceCents: number;
  /** Prazo em dias uteis; null se a API nao informar. */
  days: number | null;
};

type RawOption = {
  id?: number;
  name?: string;
  price?: string | number;
  delivery_time?: number;
  error?: string;
};

const onlyDigits = (s: string) => s.replace(/\D/g, "");

/**
 * Monta o `products[]` do payload (cubagem no SuperFrete) a partir das linhas do
 * carrinho. Peso em GRAMAS -> KG (a API espera kg); dimensoes em CM.
 */
export function buildProductsPayload(items: QuoteItem[]) {
  return items
    .filter((i) => Number.isInteger(i.quantity) && i.quantity > 0)
    .map((i) => ({
      quantity: i.quantity,
      weight: i.pkg.weightGrams / 1000,
      height: i.pkg.heightCm,
      width: i.pkg.widthCm,
      length: i.pkg.lengthCm,
    }));
}

/**
 * Parser PURO da resposta do calculator. Ignora servicos com `error` ou sem preco
 * valido; converte preco (string em reais, ex.: "23.50") -> centavos Int; ordena do
 * mais barato ao mais caro. Exportado para teste sem rede.
 */
export function parseShippingOptions(raw: unknown): ShippingOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ShippingOption[] = [];
  for (const item of raw as RawOption[]) {
    if (item?.error) continue;
    const priceNum =
      typeof item.price === "string" ? Number(item.price.replace(",", ".")) : Number(item.price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) continue;
    const days = Number(item.delivery_time);
    out.push({
      serviceCode: Number(item.id) || 0,
      name: item.name ?? "Frete",
      priceCents: Math.round(priceNum * 100),
      days: Number.isFinite(days) && days > 0 ? days : null,
    });
  }
  return out.sort((a, b) => a.priceCents - b.priceCents);
}

/** Cota o frete para um CEP de destino e as linhas do carrinho. [] = indisponivel. */
export async function quoteShipping(toCep: string, items: QuoteItem[]): Promise<ShippingOption[]> {
  if (!isSuperFreteConfigured()) return [];
  const dest = onlyDigits(toCep);
  if (dest.length !== 8) return [];
  const products = buildProductsPayload(items);
  if (products.length === 0) return [];

  const { fromCep } = getSuperFreteConfig();
  const raw = await superFreteFetch<unknown>("/api/v0/calculator", {
    method: "POST",
    body: JSON.stringify({
      from: { postal_code: fromCep },
      to: { postal_code: dest },
      services: SHIPPING_SERVICES,
      options: { own_hand: false, receipt: false, use_insurance_value: false },
      products,
    }),
  });
  return parseShippingOptions(raw);
}

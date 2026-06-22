"use client";

import Link from "next/link";
import { useState } from "react";

import {
  checkout,
  previewCoupon,
  quoteShippingAction,
  type CheckoutResult,
} from "@/app/(storefront)/carrinho/actions";
import { useCart } from "@/lib/cart/CartContext";
import { cartTotals } from "@/lib/cart/totals";
import type { ShippingOption } from "@/lib/services/superfrete/quote";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import styles from "./CheckoutView.module.css";

// UFs para o select de estado.
const UFS = [
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
] as const;

type Form = {
  name: string;
  email: string;
  phone: string;
  cpfCnpj: string;
  cep: string;
  street: string;
  city: string;
  state: string;
};

const EMPTY: Form = {
  name: "",
  email: "",
  phone: "",
  cpfCnpj: "",
  cep: "",
  street: "",
  city: "",
  state: "",
};

export function CheckoutView() {
  const { lines, hydrated, clear } = useCart();
  const [form, setForm] = useState<Form>(EMPTY);
  const [coupon, setCoupon] = useState("");
  // Chave de idempotencia estavel por sessao de checkout (invariante 2): o mesmo
  // submit/duplo-clique reenvia a MESMA chave => 1 pedido + 1 cobranca Asaas.
  const [checkoutKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<CheckoutResult, { ok: true }> | null>(null);
  const [copied, setCopied] = useState(false);
  // Previa de cupom (server-side): mantem o total exibido == total cobrado.
  const [couponPreview, setCouponPreview] = useState<{
    code: string;
    discountCents: number;
    finalTotalCents: number;
  } | null>(null);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  // Frete (cotacao server-side). shipQuoted: ja cotou para o CEP atual; shipFree:
  // mercadoria atinge o limiar (gratis); shipCode: servico escolhido.
  const [shipQuoted, setShipQuoted] = useState(false);
  const [shipFree, setShipFree] = useState(false);
  const [shipOptions, setShipOptions] = useState<ShippingOption[]>([]);
  const [shipCode, setShipCode] = useState<number | null>(null);
  const [shipLoading, setShipLoading] = useState(false);
  const [shipMsg, setShipMsg] = useState<string | null>(null);

  if (!hydrated) {
    return <p className={styles.loading}>Carregando…</p>;
  }

  // Sucesso tem precedencia: o carrinho ja foi esvaziado ao confirmar.
  if (result) {
    return <SuccessPanel result={result} copied={copied} setCopied={setCopied} />;
  }

  if (lines.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>Seu carrinho está vazio.</div>
        <p className={styles.emptySub}>Adicione produtos antes de finalizar.</p>
        <Link href="/colecoes" className={styles.primaryLink}>
          Ver coleção
        </Link>
      </div>
    );
  }

  const totals = cartTotals(lines);
  const cepDigits = form.cep.replace(/\D/g, "");
  const chosenOption = shipOptions.find((o) => o.serviceCode === shipCode) ?? null;
  const shippingForDisplay = shipFree ? 0 : (chosenOption?.priceCents ?? null);
  const shippingReady = shipQuoted && (shipFree || chosenOption != null);
  const couponDiscount = couponPreview?.discountCents ?? 0;
  // Total = mercadoria + frete escolhido - cupom (piso no frete), espelhando o server.
  // null enquanto o frete nao foi calculado (botao de pagar fica desabilitado).
  const displayTotalCents =
    shippingForDisplay == null
      ? null
      : Math.max(shippingForDisplay, totals.merchandiseCents + shippingForDisplay - couponDiscount);
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  // CEP muda -> invalida a cotacao anterior (forca recalcular; evita frete stale).
  const onCepChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, cep: e.target.value }));
    setShipQuoted(false);
    setShipMsg(null);
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const required: [keyof Form, string][] = [
      ["name", "Informe o nome."],
      ["email", "Informe o e-mail."],
      ["phone", "Informe o telefone."],
      ["cpfCnpj", "Informe o CPF/CNPJ."],
      ["cep", "Informe o CEP."],
      ["street", "Informe o endereço."],
      ["city", "Informe a cidade."],
      ["state", "Informe o estado."],
    ];
    for (const [key, msg] of required) {
      if (!form[key].trim()) {
        setError(msg);
        return;
      }
    }

    if (!shippingReady) {
      setError("Calcule o frete para finalizar.");
      return;
    }

    setSubmitting(true);
    const res = await checkout({
      checkoutKey,
      customer: { ...form },
      items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
      couponCode: coupon.trim() || undefined,
      shippingServiceCode: shipFree ? undefined : (chosenOption?.serviceCode ?? undefined),
    });
    setSubmitting(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }
    clear();
    setResult(res);
  }

  async function applyCoupon() {
    const code = coupon.trim();
    if (!code) return;
    setCouponBusy(true);
    setCouponMsg(null);
    const res = await previewCoupon({
      items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
      couponCode: code,
    });
    setCouponBusy(false);
    if (res.ok) {
      setCouponPreview({
        code: res.code,
        discountCents: res.discountCents,
        finalTotalCents: res.finalTotalCents,
      });
    } else {
      setCouponPreview(null);
      setCouponMsg(res.error);
    }
  }

  async function calcShipping() {
    if (cepDigits.length !== 8) {
      setShipMsg("Informe um CEP válido (8 dígitos) no endereço.");
      return;
    }
    setShipLoading(true);
    setShipMsg(null);
    const res = await quoteShippingAction({
      cep: form.cep,
      items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
    });
    setShipLoading(false);
    if (!res.ok) {
      setShipQuoted(false);
      setShipMsg(res.error);
      return;
    }
    setShipFree(res.free);
    setShipOptions(res.options);
    setShipCode(res.free ? null : (res.options[0]?.serviceCode ?? null));
    setShipQuoted(true);
  }

  return (
    <div className={styles.layout}>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <h2 className={styles.sectionTitle}>Dados de contato</h2>
        <div className={styles.grid}>
          <Field className={styles.full} label="Nome completo">
            <input
              className={styles.input}
              value={form.name}
              onChange={set("name")}
              autoComplete="name"
            />
          </Field>
          <Field label="E-mail">
            <input
              className={styles.input}
              type="email"
              value={form.email}
              onChange={set("email")}
              autoComplete="email"
            />
          </Field>
          <Field label="Telefone">
            <input
              className={styles.input}
              value={form.phone}
              onChange={set("phone")}
              placeholder="(41) 99999-9999"
              autoComplete="tel"
            />
          </Field>
          <Field label="CPF/CNPJ">
            <input
              className={styles.input}
              value={form.cpfCnpj}
              onChange={set("cpfCnpj")}
              placeholder="000.000.000-00"
            />
          </Field>
        </div>

        <h2 className={styles.sectionTitle}>Endereço de entrega</h2>
        <div className={styles.grid}>
          <Field label="CEP">
            <input
              className={styles.input}
              value={form.cep}
              onChange={onCepChange}
              placeholder="80000-000"
              autoComplete="postal-code"
            />
          </Field>
          <Field label="Cidade">
            <input
              className={styles.input}
              value={form.city}
              onChange={set("city")}
              autoComplete="address-level2"
            />
          </Field>
          <Field className={styles.full} label="Endereço (rua, número, complemento)">
            <input
              className={styles.input}
              value={form.street}
              onChange={set("street")}
              autoComplete="street-address"
            />
          </Field>
          <Field label="Estado (UF)">
            <select
              className={styles.select}
              value={form.state}
              onChange={set("state")}
              autoComplete="address-level1"
            >
              <option value="">—</option>
              {UFS.map((uf) => (
                <option key={uf} value={uf}>
                  {uf}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <button type="submit" className={styles.submit} disabled={submitting || !shippingReady}>
          {submitting
            ? "Gerando PIX…"
            : shippingReady && displayTotalCents != null
              ? `Pagar ${formatBRL(displayTotalCents)} via PIX`
              : "Calcule o frete para continuar"}
        </button>
        <Link href="/carrinho" className={styles.back}>
          Voltar ao carrinho
        </Link>
      </form>

      <aside className={styles.summary}>
        <h2 className={styles.summaryTitle}>Resumo</h2>
        <ul className={styles.items}>
          {lines.map((l) => {
            const unit = finalPriceCents(l.product);
            return (
              <li key={l.product.id} className={styles.itemRow}>
                <span className={styles.itemName}>
                  {l.product.name} <span className={styles.itemQty}>× {l.quantity}</span>
                </span>
                <span className="tnum">{formatBRL(unit * l.quantity)}</span>
              </li>
            );
          })}
        </ul>
        <div className={styles.field}>
          <span className={styles.label}>Cupom de desconto</span>
          <div className={styles.copyRow}>
            <input
              className={styles.input}
              value={coupon}
              onChange={(e) => {
                setCoupon(e.target.value.toUpperCase());
                setCouponPreview(null);
                setCouponMsg(null);
              }}
              placeholder="Tem um cupom? (opcional)"
              autoCapitalize="characters"
              aria-label="Código do cupom"
            />
            <button
              type="button"
              className={styles.copyBtn}
              onClick={applyCoupon}
              disabled={couponBusy || !coupon.trim()}
            >
              {couponBusy ? "…" : "Aplicar"}
            </button>
          </div>
          {couponMsg && (
            <p className={styles.error} role="alert">
              {couponMsg}
            </p>
          )}
        </div>
        <dl className={styles.rows}>
          <div className={styles.row}>
            <dt>Subtotal</dt>
            <dd className="tnum">{formatBRL(totals.subtotalCents)}</dd>
          </div>
          {totals.discountCents > 0 && (
            <div className={styles.row}>
              <dt>Desconto</dt>
              <dd className="tnum">- {formatBRL(totals.discountCents)}</dd>
            </div>
          )}
          {couponPreview && (
            <div className={styles.row}>
              <dt>Cupom ({couponPreview.code})</dt>
              <dd className="tnum">- {formatBRL(couponPreview.discountCents)}</dd>
            </div>
          )}
          <div className={styles.row}>
            <dt>Frete</dt>
            <dd className="tnum">
              {shipFree
                ? "Grátis"
                : shippingForDisplay != null
                  ? formatBRL(shippingForDisplay)
                  : "—"}
            </dd>
          </div>
        </dl>

        <div className={styles.shipBox}>
          <button
            type="button"
            className={styles.shipBtn}
            onClick={calcShipping}
            disabled={shipLoading || cepDigits.length !== 8}
          >
            {shipLoading ? "Calculando…" : shipQuoted ? "Recalcular frete" : "Calcular frete"}
          </button>
          {cepDigits.length !== 8 && (
            <p className={styles.shipHint}>Preencha o CEP no endereço para calcular o frete.</p>
          )}
          {shipMsg && (
            <p className={styles.error} role="alert">
              {shipMsg}
            </p>
          )}
          {shipQuoted && shipFree && (
            <p className={styles.shipFree}>Frete grátis nesta compra 🎉</p>
          )}
          {shipQuoted && !shipFree && (
            <div className={styles.shipOpts} role="radiogroup" aria-label="Opções de frete">
              {shipOptions.map((o) => (
                <label key={o.serviceCode} className={styles.shipOpt}>
                  <input
                    type="radio"
                    name="ship"
                    checked={shipCode === o.serviceCode}
                    onChange={() => setShipCode(o.serviceCode)}
                  />
                  <span className={styles.shipOptName}>
                    {o.name}
                    {o.days != null && (
                      <span className={styles.shipDays}> · {o.days} dias úteis</span>
                    )}
                  </span>
                  <span className="tnum">{formatBRL(o.priceCents)}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className={styles.total}>
          <span>Total</span>
          <span className="tnum">
            {displayTotalCents != null ? formatBRL(displayTotalCents) : "—"}
          </span>
        </div>
      </aside>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`${styles.field} ${className ?? ""}`}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}

function SuccessPanel({
  result,
  copied,
  setCopied,
}: {
  result: Extract<CheckoutResult, { ok: true }>;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  const { orderId, pix, invoiceUrl } = result;

  async function copyPayload() {
    if (!pix) return;
    try {
      await navigator.clipboard.writeText(pix.payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard indisponivel — o usuario ainda pode copiar manualmente do campo.
    }
  }

  return (
    <div className={styles.success}>
      <div className={styles.successHead}>
        <span className={styles.check} aria-hidden>
          ✓
        </span>
        <div>
          <h2 className={styles.successTitle}>Pedido {orderId} criado!</h2>
          <p className={styles.successSub}>
            {pix
              ? "Escaneie o QR Code ou use o copia-e-cola para pagar via PIX."
              : "Conclua o pagamento pela fatura abaixo."}
          </p>
        </div>
      </div>

      {pix && (
        <div className={styles.pixBox}>
          {/* QR vem como base64 do Asaas; data URI nao se beneficia do next/image. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.qr}
            src={`data:image/png;base64,${pix.encodedImage}`}
            alt="QR Code do PIX"
            width={220}
            height={220}
          />
          <label className={styles.label} htmlFor="pix-payload">
            PIX copia-e-cola
          </label>
          <div className={styles.copyRow}>
            <input id="pix-payload" className={styles.input} readOnly value={pix.payload} />
            <button type="button" className={styles.copyBtn} onClick={copyPayload}>
              {copied ? "Copiado!" : "Copiar"}
            </button>
          </div>
        </div>
      )}

      {invoiceUrl && (
        <a className={styles.invoice} href={invoiceUrl} target="_blank" rel="noopener noreferrer">
          {pix ? "Abrir fatura no Asaas" : "Pagar pela fatura"}
        </a>
      )}

      {!pix && !invoiceUrl && (
        <p className={styles.successSub}>
          Pagamento PIX será habilitado em breve. Acompanhe o status em Minhas Compras.
        </p>
      )}

      <div className={styles.successActions}>
        <Link href="/minhas-compras" className={styles.primaryLink}>
          Ver meus pedidos
        </Link>
        <Link href="/colecoes" className={styles.back}>
          Continuar comprando
        </Link>
      </div>
    </div>
  );
}

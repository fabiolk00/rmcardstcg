"use client";

import { carrierLabel } from "@/lib/data/carriers";
import { formatCityLine, formatStreetLine } from "@/lib/data/address";
import { formatDocument } from "@/lib/utils/document";
import { paymentMethodLabel } from "@/lib/payments/method";
import type { Order, PaymentStatus, ShippingStatus } from "@/lib/data/types";
import { formatBRL } from "@/lib/utils/currency";
import { Modal } from "@/components/ui/Modal";
import styles from "./OrderDetailsModal.module.css";

/**
 * Analitico do pedido: TUDO que o cliente preencheu no checkout, mais o que o
 * pedido virou (frete cotado, cupom, totais, envio, etiqueta). Somente leitura —
 * quem muda alguma coisa e o modal de status.
 *
 * Serve a duas perguntas do dia a dia: "para onde eu mando isso?" (o admin nao
 * via endereco em lugar nenhum antes) e "por que a etiqueta nao emite?" — os
 * campos que faltam em pedido legado aparecem explicitamente como nao informados.
 */
const PAY_LABEL: Record<PaymentStatus, string> = {
  paid: "Pago",
  pending: "Pendente",
  cancelled: "Cancelado",
};

const SHIP_LABEL: Record<ShippingStatus, string> = {
  pending: "A enviar",
  sent: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado",
};

function formatCep(cep: string): string {
  const d = cep.replace(/\D/g, "");
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : cep;
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

/** Linha do analitico. Valor ausente vira "não informado" — o vazio importa aqui. */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  const missing = value == null || value.trim() === "";
  return (
    <div className={styles.row}>
      <dt className={styles.rowLabel}>{label}</dt>
      <dd className={`${styles.rowValue} ${missing ? styles.missing : ""}`}>
        {missing ? "não informado" : value}
      </dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles.block}>
      <h3 className={styles.blockTitle}>{title}</h3>
      <dl className={styles.rows}>{children}</dl>
    </section>
  );
}

export function OrderDetailsModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const label = order.shippingLabel;
  const itemsCount = order.items.reduce((sum, i) => sum + i.quantity, 0);

  return (
    <Modal
      title="Analítico do pedido"
      sub={`${order.id} — ${formatDateTime(order.createdAt)}`}
      onClose={onClose}
      footer={
        <button type="button" className={styles.secondary} onClick={onClose}>
          Cancelar
        </button>
      }
    >
      <Block title="Cliente">
        <Row label="Nome" value={order.customerName} />
        <Row label="E-mail" value={order.customerEmail} />
        <Row label="Telefone" value={order.customerPhone} />
        <Row label="CPF/CNPJ" value={formatDocument(order.customerDocument)} />
      </Block>

      <Block title="Entrega">
        <Row label="Endereço" value={formatStreetLine(order.address)} />
        <Row label="Número" value={order.address.number} />
        <Row label="Complemento" value={order.address.complement} />
        <Row label="Bairro" value={order.address.district} />
        <Row label="Cidade/UF" value={formatCityLine(order.address)} />
        <Row label="CEP" value={formatCep(order.address.cep)} />
      </Block>

      <Block title="Pagamento">
        <Row label="Status" value={PAY_LABEL[order.paymentStatus]} />
        <Row label="Forma" value={paymentMethodLabel(order.paymentMethod)} />
        <Row label="Cupom" value={order.couponCode} />
      </Block>

      <Block title="Frete">
        <Row label="Modalidade" value={order.shippingService} />
        <Row
          label="Código da modalidade"
          value={order.shippingServiceCode != null ? String(order.shippingServiceCode) : null}
        />
        <Row label="Prazo" value={order.shippingDays} />
        <Row label="Valor cobrado" value={formatBRL(order.shippingCents)} />
      </Block>

      <Block title="Envio">
        <Row label="Status" value={SHIP_LABEL[order.shippingStatus]} />
        <Row label="Transportadora" value={order.shippingCarrier ? carrierLabel(order.shippingCarrier) : null} />
        <Row label="Rastreio" value={order.trackingCode} />
        <Row
          label="Etiqueta"
          value={
            label
              ? `${label.status} — ${formatBRL(label.costCents)} (${label.superFreteId})`
              : null
          }
        />
      </Block>

      <Block title="Itens">
        {order.items.map((item) => (
          <Row
            key={item.productId}
            label={`${item.quantity}× ${item.productName}`}
            value={formatBRL(item.unitPriceCents * item.quantity)}
          />
        ))}
        <Row label="Subtotal" value={formatBRL(order.subtotalCents)} />
        {order.discountCents > 0 && (
          <Row label="Desconto de produto" value={`- ${formatBRL(order.discountCents)}`} />
        )}
        {order.couponDiscountCents > 0 && (
          <Row label="Desconto do cupom" value={`- ${formatBRL(order.couponDiscountCents)}`} />
        )}
        <Row label="Frete" value={formatBRL(order.shippingCents)} />
        <Row label={`Total (${itemsCount} itens)`} value={formatBRL(order.totalCents)} />
      </Block>

      {order.internalNote && (
        <Block title="Nota interna">
          <Row label="Anotação" value={order.internalNote} />
        </Block>
      )}
    </Modal>
  );
}

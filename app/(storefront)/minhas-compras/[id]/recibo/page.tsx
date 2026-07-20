import { formatAddressOneLine } from "@/lib/data/address";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { requireActiveUser } from "@/lib/auth/requireActiveUser";
import { SITE_NAME } from "@/lib/config/site";
import { carrierLabel } from "@/lib/data/carriers";
import { getOrderForUser } from "@/lib/data/orders";
import { paymentMethodLabel } from "@/lib/payments/method";
import { formatBRL } from "@/lib/utils/currency";
import { Icon } from "@/components/ui/Icon";
import { PrintButton } from "@/components/orders/PrintButton";
import { PAYMENT_LABEL, SHIPPING_LABEL } from "../../labels";
import styles from "./recibo.module.css";

// Comprovante ao vivo (status muda fora do build).
export const dynamic = "force-dynamic";

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default async function ReciboPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Mesma postura do detalhe: login + espelho ATIVO (soft-deleted bloqueia);
  // mock-first cai em "guest".
  const active = await requireActiveUser();
  if (!active.ok) redirect(active.reason === "deleted" ? "/" : "/entrar");
  const userId = active.userId;

  // Guard de posse (anti-IDOR): comprovante de outro usuario -> 404.
  const order = await getOrderForUser(id, userId);
  if (!order) notFound();

  const numericId = order.id.replace(/^#/, "");

  return (
    <div className={`${styles.page} receipt-print-root`}>
      <div className={`${styles.toolbar} noprint`}>
        <Link href={`/minhas-compras/${numericId}`} className={styles.back}>
          <Icon name="chevronLeft" size={16} />
          <span>Voltar ao pedido</span>
        </Link>
        <PrintButton className={styles.printBtn} />
      </div>

      <article className={styles.receipt}>
        <header className={styles.head}>
          <div className={styles.brand}>{SITE_NAME}</div>
          <div className={styles.docTitle}>Comprovante de pedido</div>
        </header>

        <dl className={styles.metaGrid}>
          <div>
            <dt>Pedido</dt>
            <dd className={styles.mono}>{order.id}</dd>
          </div>
          <div>
            <dt>Data</dt>
            <dd>{formatDateTime(order.createdAt)}</dd>
          </div>
          <div>
            <dt>Pagamento</dt>
            <dd>{PAYMENT_LABEL[order.paymentStatus]}</dd>
          </div>
          <div>
            <dt>Forma de pgto</dt>
            <dd>{paymentMethodLabel(order.paymentMethod)}</dd>
          </div>
          <div>
            <dt>Envio</dt>
            <dd>{SHIPPING_LABEL[order.shippingStatus]}</dd>
          </div>
        </dl>

        <section className={styles.block}>
          <h2 className={styles.blockTitle}>Cliente</h2>
          <p className={styles.party}>
            <strong>{order.customerName}</strong>
            <br />
            {order.customerEmail} · {order.customerPhone}
            <br />
            {formatAddressOneLine(order.address)} — CEP{" "}
            {order.address.cep}
          </p>
        </section>

        <table className={styles.table}>
          <thead>
            <tr>
              <th>Produto</th>
              <th className={styles.right}>Qtd</th>
              <th className={styles.right}>Unitário</th>
              <th className={styles.right}>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((it) => (
              <tr key={it.productId}>
                <td>{it.productName}</td>
                <td className={styles.right}>{it.quantity}</td>
                <td className={`${styles.right} tnum`}>{formatBRL(it.unitPriceCents)}</td>
                <td className={`${styles.right} tnum`}>
                  {formatBRL(it.unitPriceCents * it.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className={styles.totals}>
          <div>
            <dt>Subtotal</dt>
            <dd className="tnum">{formatBRL(order.subtotalCents)}</dd>
          </div>
          {order.discountCents > 0 && (
            <div>
              <dt>Desconto</dt>
              <dd className="tnum">- {formatBRL(order.discountCents)}</dd>
            </div>
          )}
          {order.couponDiscountCents > 0 && (
            <div>
              <dt>Cupom{order.couponCode ? ` (${order.couponCode})` : ""}</dt>
              <dd className="tnum">- {formatBRL(order.couponDiscountCents)}</dd>
            </div>
          )}
          <div>
            <dt>Frete</dt>
            <dd className="tnum">
              {order.shippingCents === 0 ? "Grátis" : formatBRL(order.shippingCents)}
            </dd>
          </div>
          <div className={styles.totalFinal}>
            <dt>Total</dt>
            <dd className="tnum">{formatBRL(order.totalCents)}</dd>
          </div>
        </dl>

        {order.trackingCode && (
          <p className={styles.tracking}>
            Rastreio: <span className={styles.mono}>{order.trackingCode}</span>
            {order.shippingCarrier ? ` · ${carrierLabel(order.shippingCarrier)}` : ""}
          </p>
        )}

        <footer className={styles.foot}>
          Comprovante de pedido gerado em {SITE_NAME} — não é documento fiscal.
        </footer>
      </article>
    </div>
  );
}

import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { carrierLabel, carrierTrackingUrl } from "@/lib/data/carriers";
import { getOrderForUser } from "@/lib/data/orders";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { formatBRL } from "@/lib/utils/currency";
import { Icon } from "@/components/ui/Icon";
import { OrderPaymentSection } from "@/components/orders/OrderPaymentSection";
import { PAYMENT_LABEL, SHIPPING_LABEL } from "../labels";
import styles from "./order-detail.module.css";

// Detalhe do pedido — sempre ao vivo (status muda fora do build).
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

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Mesma postura da lista: com Clerk exige login; mock-first cai em "guest".
  let userId = "guest";
  if (isClerkConfigured()) {
    const { userId: clerkId } = await auth();
    if (!clerkId) redirect("/entrar");
    userId = clerkId;
  }

  // Guard de posse centralizado: pedido inexistente OU de outro usuario -> 404
  // (não distingue os casos, para não permitir enumeração de pedidos alheios).
  const order = await getOrderForUser(id, userId);
  if (!order) notFound();

  const numericId = order.id.replace(/^#/, "");
  const itemsCount = order.items.reduce((sum, i) => sum + i.quantity, 0);
  const trackingUrl = carrierTrackingUrl(order.shippingCarrier, order.trackingCode);

  return (
    <section className={styles.wrap}>
      <Link href="/minhas-compras" className={styles.back}>
        <Icon name="chevronLeft" size={16} />
        <span>Minhas Compras</span>
      </Link>

      <header className={styles.head}>
        <div>
          <h1 className={styles.title}>Pedido {order.id}</h1>
          <p className={styles.date}>{formatDateTime(order.createdAt)}</p>
        </div>
        <div className={styles.badges}>
          <span className={`${styles.pill} ${styles[`pay_${order.paymentStatus}`]}`}>
            {PAYMENT_LABEL[order.paymentStatus]}
          </span>
          <span className={`${styles.pill} ${styles[`ship_${order.shippingStatus}`]}`}>
            {SHIPPING_LABEL[order.shippingStatus]}
          </span>
        </div>
      </header>

      {order.paymentStatus === "pending" && (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Pagamento pendente</h2>
          <p className={styles.sectionSub}>
            Pague via PIX para confirmar seu pedido. O QR Code abaixo é o mesmo da sua cobrança.
          </p>
          <OrderPaymentSection orderId={numericId} />
        </div>
      )}

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>
          {itemsCount} {itemsCount === 1 ? "item" : "itens"}
        </h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Produto</th>
                <th scope="col" className={styles.right}>
                  Qtd
                </th>
                <th scope="col" className={styles.right}>
                  Unitário
                </th>
                <th scope="col" className={styles.right}>
                  Subtotal
                </th>
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
        </div>
      </div>

      <div className={styles.cols}>
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Resumo</h2>
          <dl className={styles.totals}>
            <div className={styles.totRow}>
              <dt>Subtotal</dt>
              <dd className="tnum">{formatBRL(order.subtotalCents)}</dd>
            </div>
            {order.discountCents > 0 && (
              <div className={styles.totRow}>
                <dt>Desconto</dt>
                <dd className="tnum">- {formatBRL(order.discountCents)}</dd>
              </div>
            )}
            {order.couponDiscountCents > 0 && (
              <div className={styles.totRow}>
                <dt>Cupom{order.couponCode ? ` (${order.couponCode})` : ""}</dt>
                <dd className="tnum">- {formatBRL(order.couponDiscountCents)}</dd>
              </div>
            )}
            <div className={styles.totRow}>
              <dt>Frete</dt>
              <dd className="tnum">
                {order.shippingCents === 0 ? "Grátis" : formatBRL(order.shippingCents)}
              </dd>
            </div>
            <div className={`${styles.totRow} ${styles.totFinal}`}>
              <dt>Total</dt>
              <dd className="tnum">{formatBRL(order.totalCents)}</dd>
            </div>
          </dl>
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Entrega</h2>
          <div className={styles.address}>
            <div className={styles.addrName}>{order.customerName}</div>
            <div>{order.address.street}</div>
            <div>
              {order.address.city}/{order.address.state} — CEP {order.address.cep}
            </div>
          </div>
          <p className={styles.shipStatus}>
            Status: <strong>{SHIPPING_LABEL[order.shippingStatus]}</strong>
            {order.shippingService ? (
              <span className={styles.shipService}>
                {" · "}
                {order.shippingService}
                {order.shippingDays ? ` (${order.shippingDays})` : ""}
              </span>
            ) : null}
          </p>

          {order.trackingCode && (
            <p className={styles.tracking}>
              Rastreio: <strong className={styles.trackCode}>{order.trackingCode}</strong>
              {order.shippingCarrier && (
                <span className={styles.shipService}> · {carrierLabel(order.shippingCarrier)}</span>
              )}
              {trackingUrl && (
                <a
                  href={trackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.trackLink}
                >
                  Rastrear <Icon name="arrow" size={13} />
                </a>
              )}
            </p>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        <Link href={`/minhas-compras/${numericId}/recibo`} className={styles.shopMore}>
          <Icon name="receipt" size={15} /> Comprovante
        </Link>
        <Link href="/colecoes" className={styles.shopMore}>
          Continuar comprando <Icon name="arrow" size={15} />
        </Link>
      </div>
    </section>
  );
}

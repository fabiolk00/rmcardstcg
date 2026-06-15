import { getOrders } from "@/lib/data/orders";
import { getProfile } from "@/lib/data/profile";
import type { PaymentStatus, ShippingStatus } from "@/lib/data/types";
import { formatBRL } from "@/lib/utils/currency";
import styles from "./minhas-compras.module.css";

const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  paid: "Pago",
  pending: "Pendente",
  cancelled: "Cancelado",
};

const SHIPPING_LABEL: Record<ShippingStatus, string> = {
  pending: "A enviar",
  sent: "Enviado",
  delivered: "Entregue",
  cancelled: "Cancelado",
};

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

export default async function MinhasComprasPage() {
  // Mock: mostra todos os pedidos como compras do cliente demo. No F11 (pedidos
  // reais) troca por getOrdersByUserId(userId) do usuario autenticado.
  const [orders, profile] = await Promise.all([getOrders(), getProfile()]);
  const totalPaidCents = orders
    .filter((o) => o.paymentStatus === "paid")
    .reduce((sum, o) => sum + o.totalCents, 0);

  return (
    <section>
      <h1 className={styles.title}>Minhas Compras</h1>

      <div className={styles.profile}>
        <div className={styles.profileName}>{profile.name}</div>
        <dl className={styles.profileGrid}>
          <div>
            <dt>Telefone</dt>
            <dd>{profile.phone}</dd>
          </div>
          <div>
            <dt>CEP</dt>
            <dd>{profile.cep}</dd>
          </div>
          <div>
            <dt>Endereço</dt>
            <dd>{profile.address}</dd>
          </div>
        </dl>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Pedido</th>
              <th>Data</th>
              <th>Itens</th>
              <th>Pagamento</th>
              <th>Envio</th>
              <th className={styles.right}>Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const items = order.items.reduce((sum, i) => sum + i.quantity, 0);
              return (
                <tr key={order.id}>
                  <td className={styles.mono}>{order.id}</td>
                  <td>{formatDate(order.createdAt)}</td>
                  <td>
                    {items} {items === 1 ? "item" : "itens"}
                  </td>
                  <td>
                    <span className={`${styles.pill} ${styles[`pay_${order.paymentStatus}`]}`}>
                      {PAYMENT_LABEL[order.paymentStatus]}
                    </span>
                  </td>
                  <td>
                    <span className={`${styles.pill} ${styles[`ship_${order.shippingStatus}`]}`}>
                      {SHIPPING_LABEL[order.shippingStatus]}
                    </span>
                  </td>
                  <td className={`${styles.right} tnum`}>{formatBRL(order.totalCents)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5} className={styles.right}>
                Total pago
              </td>
              <td className={`${styles.right} tnum`}>{formatBRL(totalPaidCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

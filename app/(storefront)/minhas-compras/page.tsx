import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getOrdersByUserId } from "@/lib/data/orders";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { formatBRL } from "@/lib/utils/currency";
import { PAYMENT_LABEL, SHIPPING_LABEL } from "./labels";
import styles from "./minhas-compras.module.css";

// Pedidos do usuario — sempre ao vivo (nada de snapshot no build).
export const dynamic = "force-dynamic";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

export default async function MinhasComprasPage() {
  // Pedidos do usuario AUTENTICADO. Fecha o vazamento de IDOR: NUNCA getOrders()
  // (que traria os pedidos de todos os clientes). Com Clerk, o middleware ja
  // protege esta rota; sem Clerk (mock-first), cai no usuario "guest".
  let userId = "guest";
  if (isClerkConfigured()) {
    const { userId: clerkId } = await auth();
    if (!clerkId) redirect("/entrar");
    userId = clerkId;
  }

  const orders = await getOrdersByUserId(userId);
  const totalPaidCents = orders
    .filter((o) => o.paymentStatus === "paid")
    .reduce((sum, o) => sum + o.totalCents, 0);

  // Perfil derivado do pedido mais recente do PROPRIO usuario (sem mock global).
  const latest = orders[0];

  return (
    <section>
      <h1 className={styles.title}>Minhas Compras</h1>

      {orders.length === 0 ? (
        <p>Você ainda não tem compras.</p>
      ) : (
        <>
          {latest && (
            <div className={styles.profile}>
              <div className={styles.profileName}>{latest.customerName}</div>
              <dl className={styles.profileGrid}>
                <div>
                  <dt>Telefone</dt>
                  <dd>{latest.customerPhone}</dd>
                </div>
                <div>
                  <dt>CEP</dt>
                  <dd>{latest.address.cep}</dd>
                </div>
                <div>
                  <dt>Endereço</dt>
                  <dd>
                    {latest.address.street} — {latest.address.city}/{latest.address.state}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Pedido</th>
                  <th scope="col">Data</th>
                  <th scope="col">Itens</th>
                  <th scope="col">Pagamento</th>
                  <th scope="col">Envio</th>
                  <th scope="col" className={styles.right}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const items = order.items.reduce((sum, i) => sum + i.quantity, 0);
                  return (
                    <tr key={order.id}>
                      <td className={styles.mono}>
                        <Link
                          href={`/minhas-compras/${order.id.replace(/^#/, "")}`}
                          className={styles.detailLink}
                        >
                          {order.id}
                        </Link>
                      </td>
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
                        <span
                          className={`${styles.pill} ${styles[`ship_${order.shippingStatus}`]}`}
                        >
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
        </>
      )}
    </section>
  );
}

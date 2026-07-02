import Link from "next/link";
import { redirect } from "next/navigation";

import { PAYMENT_LABEL, SHIPPING_LABEL } from "@/app/(storefront)/minhas-compras/labels";
import { requireActiveUser } from "@/lib/auth/requireActiveUser";
import { getOrdersByUserId } from "@/lib/data/orders";
import type { Order } from "@/lib/data/types";
import { formatBRL } from "@/lib/utils/currency";
import styles from "./pedidos.module.css";

// Pedidos do usuario — sempre ao vivo (nada de snapshot no build).
export const dynamic = "force-dynamic";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

export default async function PainelPedidosPage() {
  // Pedidos do usuario AUTENTICADO E ATIVO (anti-IDOR: NUNCA getOrders()
  // global). O layout do painel ja roda o guard, mas a page repete — actions
  // e prefetch podem alcancar a rota sem passar pelo layout renderizado.
  const active = await requireActiveUser();
  if (!active.ok) redirect(active.reason === "deleted" ? "/" : "/entrar");
  const userId = active.userId;

  // Estado de erro: leitura do banco pode falhar; a tela degrada com aviso
  // em vez de derrubar o shell inteiro do painel.
  let orders: Order[];
  try {
    orders = await getOrdersByUserId(userId);
  } catch (err) {
    console.error("[painel] falha ao carregar pedidos:", err instanceof Error ? err.message : err);
    return (
      <section>
        <h1 className={styles.title}>Meus Pedidos</h1>
        <p>Não foi possível carregar seus pedidos. Tente novamente mais tarde.</p>
      </section>
    );
  }

  const totalPaidCents = orders
    .filter((o) => o.paymentStatus === "paid")
    .reduce((sum, o) => sum + o.totalCents, 0);

  return (
    <section>
      <h1 className={styles.title}>Meus Pedidos</h1>

      {orders.length === 0 ? (
        <p>
          Você ainda não tem compras. <Link href="/painel/colecoes">Ver coleções</Link>
        </p>
      ) : (
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
      )}
    </section>
  );
}

"use client";

import {
  cancelLabelAction,
  issueLabelAction,
  printLabelAction,
} from "@/app/admin/pedidos/labelActions";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { Order, PaymentStatus, ShippingStatus } from "@/lib/data/types";
import { paymentMethodLabel } from "@/lib/payments/method";
import { formatBRL } from "@/lib/utils/currency";
import { Icon } from "@/components/ui/Icon";
import { Pagination } from "@/components/ui/Pagination";
import { OrderStatusModal } from "./OrderStatusModal";
import {
  adjustPaymentStatusAction,
  updateInternalNoteAction,
  updateShippingStatusAction,
  updateTrackingAction,
} from "@/app/admin/pedidos/actions";
import styles from "./AdminOrdersView.module.css";

const PER_PAGE = 8;
type PaySeg = "all" | PaymentStatus;

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

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

export function AdminOrdersView({ orders: initialOrders }: { orders: Order[] }) {
  // Mutacoes em estado de cliente (efemeras no mock). Persistencia real no F11.
  const [orders, setOrders] = useState<Order[]>(initialOrders);
  const [query, setQuery] = useState("");
  const [seg, setSeg] = useState<PaySeg>("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Order | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const kpis = useMemo(
    () => ({
      revenueCents: orders
        .filter((o) => o.paymentStatus === "paid")
        .reduce((s, o) => s + o.totalCents, 0),
      pendingPay: orders.filter((o) => o.paymentStatus === "pending").length,
      toShip: orders.filter((o) => o.paymentStatus === "paid" && o.shippingStatus === "pending")
        .length,
      cancelled: orders.filter((o) => o.paymentStatus === "cancelled").length,
    }),
    [orders],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (
        q &&
        !(
          o.customerName.toLowerCase().includes(q) ||
          o.customerEmail.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q)
        )
      ) {
        return false;
      }
      if (seg !== "all" && o.paymentStatus !== seg) return false;
      return true;
    });
  }, [orders, query, seg]);

  const paged = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const payClass = (s: PaymentStatus) =>
    s === "paid" ? styles.pillGreen : s === "cancelled" ? styles.pillRed : styles.pillNeutral;
  const shipClass = (s: ShippingStatus) =>
    s === "delivered" ? styles.pillGreen : s === "cancelled" ? styles.pillRed : styles.pillNeutral;

  // Servidor e a fonte de verdade: aplica na lista o Order retornado pela action
  // (ja com os campos persistidos), em vez de adivinhar o novo estado no client.
  const handleSaved = (updated: Order) => {
    startTransition(() => {
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      setEditing(null);
      setToast("Status atualizado.");
    });
  };

  return (
    <section>
      <div className={styles.head}>
        <h1 className={styles.title}>Pedidos</h1>
        <p className={styles.sub}>{orders.length} pedidos no total</p>
      </div>

      <div className={styles.kpis}>
        <div className={styles.kpi}>
          <span className={`${styles.kpiValue} tnum`}>{formatBRL(kpis.revenueCents)}</span>
          <span className={styles.kpiLabel}>Receita confirmada</span>
        </div>
        <div className={styles.kpi}>
          <span className={`${styles.kpiValue} tnum`}>{kpis.pendingPay}</span>
          <span className={styles.kpiLabel}>Aguardando pagamento</span>
        </div>
        <div className={styles.kpi}>
          <span className={`${styles.kpiValue} tnum`}>{kpis.toShip}</span>
          <span className={styles.kpiLabel}>A enviar</span>
        </div>
        <div className={styles.kpi}>
          <span className={`${styles.kpiValue} tnum`}>{kpis.cancelled}</span>
          <span className={styles.kpiLabel}>Cancelados</span>
        </div>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Icon name="search" size={15} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por cliente, e-mail ou nº…"
            aria-label="Buscar pedidos"
          />
        </div>
        <div className={styles.seg} role="group" aria-label="Filtrar por pagamento">
          {(["all", "paid", "pending", "cancelled"] as PaySeg[]).map((s) => (
            <button
              key={s}
              type="button"
              className={seg === s ? styles.segOn : ""}
              onClick={() => {
                setSeg(s);
                setPage(1);
              }}
              aria-pressed={seg === s}
            >
              {s === "all" ? "Todos" : PAY_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.left}>
                Pedido
              </th>
              <th scope="col" className={styles.left}>
                Cliente
              </th>
              <th scope="col" className={styles.center}>
                Itens
              </th>
              <th scope="col" className={styles.left}>
                Data
              </th>
              <th scope="col" className={styles.right}>
                Total
              </th>
              <th scope="col" className={styles.left}>
                Pagamento
              </th>
              <th scope="col" className={styles.left}>
                Envio
              </th>
              <th scope="col" className={styles.right}>
                Ações
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((o) => {
              const items = o.items.reduce((s, i) => s + i.quantity, 0);
              return (
                <tr key={o.id}>
                  <td className={`${styles.left} ${styles.mono}`}>{o.id}</td>
                  <td className={styles.left}>
                    <span className={styles.customer}>
                      <span className={styles.customerName}>{o.customerName}</span>
                      <span className={styles.customerSub}>{o.customerEmail}</span>
                    </span>
                  </td>
                  <td className={`${styles.center} tnum`}>{items}</td>
                  <td className={styles.left}>{formatDate(o.createdAt)}</td>
                  <td className={`${styles.right} ${styles.total} tnum`}>
                    {formatBRL(o.totalCents)}
                  </td>
                  <td className={styles.left}>
                    <span className={styles.customer}>
                      <span className={`${styles.pill} ${payClass(o.paymentStatus)}`}>
                        {PAY_LABEL[o.paymentStatus]}
                      </span>
                      <span className={styles.customerSub}>
                        {paymentMethodLabel(o.paymentMethod)}
                      </span>
                    </span>
                  </td>
                  <td className={styles.left}>
                    <span className={`${styles.pill} ${shipClass(o.shippingStatus)}`}>
                      {SHIP_LABEL[o.shippingStatus]}
                    </span>
                  </td>
                  <td className={styles.right}>
                    <button
                      type="button"
                      className={styles.statusBtn}
                      onClick={() => setEditing(o)}
                    >
                      Mudar status
                    </button>
                  </td>
                </tr>
              );
            })}
            {paged.length === 0 && (
              <tr>
                <td colSpan={8} className={styles.emptyCell}>
                  Nenhum pedido encontrado com esses filtros.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        total={filtered.length}
        perPage={PER_PAGE}
        onChange={setPage}
        label="pedidos"
      />

      {editing && (
        <OrderStatusModal
          order={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          handlers={{
            onShipping: (to) => updateShippingStatusAction(editing.id, to),
            onPayment: (to, reason) => adjustPaymentStatusAction(editing.id, to, reason),
            onNote: (note) => updateInternalNoteAction(editing.id, note),
            onTracking: (code, carrier) => updateTrackingAction(editing.id, code, carrier),
            onIssueLabel: () => issueLabelAction(editing.id),
            onPrintLabel: (format) => printLabelAction(editing.id, format),
            onCancelLabel: () => cancelLabelAction(editing.id),
          }}
        />
      )}
      {toast && (
        <div className={styles.toast} role="status" aria-live="polite" aria-atomic="true">
          {toast}
        </div>
      )}
    </section>
  );
}

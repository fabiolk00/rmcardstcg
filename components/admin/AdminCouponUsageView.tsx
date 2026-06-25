import Link from "next/link";

import type { Coupon, CouponRedemptionEntry } from "@/lib/data/coupons";
import { formatBRL } from "@/lib/utils/currency";
import { Icon } from "@/components/ui/Icon";
import styles from "./AdminCouponUsageView.module.css";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function couponValueLabel(c: Coupon): string {
  if (c.type === "percent" && c.percentOff !== null) return `-${c.percentOff}%`;
  if (c.type === "fixed" && c.valueCents !== null) return `-${formatBRL(c.valueCents)}`;
  return "—";
}

function usageLabel(c: Coupon): string {
  return c.maxRedemptions === null
    ? `${c.redeemedCount} / ∞`
    : `${c.redeemedCount} / ${c.maxRedemptions}`;
}

export function AdminCouponUsageView({
  coupon,
  redemptions,
}: {
  coupon: Coupon;
  redemptions: CouponRedemptionEntry[];
}) {
  return (
    <section>
      <Link href="/admin/cupons" className={styles.back}>
        <Icon name="chevronLeft" size={16} />
        <span>Cupons</span>
      </Link>

      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>
            Usos do cupom <span className={styles.mono}>{coupon.code}</span>
          </h1>
          <p className={styles.sub}>
            {coupon.type === "percent" ? "Percentual" : "Valor fixo"} · {couponValueLabel(coupon)}
          </p>
        </div>
        <span
          className={`${styles.pill} ${coupon.isActive ? styles.pillActive : styles.pillInactive}`}
        >
          {coupon.isActive ? "Ativo" : "Inativo"}
        </span>
      </div>

      <dl className={styles.summary}>
        <div className={styles.summaryRow}>
          <dt>Desconto</dt>
          <dd className="tnum">{couponValueLabel(coupon)}</dd>
        </div>
        <div className={styles.summaryRow}>
          <dt>Usos</dt>
          <dd className="tnum">{usageLabel(coupon)}</dd>
        </div>
        <div className={styles.summaryRow}>
          <dt>Mín. pedido</dt>
          <dd className="tnum">
            {coupon.minSubtotalCents > 0 ? formatBRL(coupon.minSubtotalCents) : "—"}
          </dd>
        </div>
        <div className={styles.summaryRow}>
          <dt>Início</dt>
          <dd className="tnum">{formatDate(coupon.startsAt)}</dd>
        </div>
        <div className={styles.summaryRow}>
          <dt>Validade</dt>
          <dd className="tnum">{formatDate(coupon.expiresAt)}</dd>
        </div>
        <div className={styles.summaryRow}>
          <dt>Status</dt>
          <dd>{coupon.isActive ? "Ativo" : "Inativo"}</dd>
        </div>
      </dl>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.left}>
                Data do uso
              </th>
              <th scope="col" className={styles.left}>
                Pedido
              </th>
              <th scope="col" className={styles.left}>
                Cliente
              </th>
              <th scope="col" className={styles.right}>
                Total do pedido
              </th>
              <th scope="col" className={styles.right}>
                Desconto aplicado
              </th>
            </tr>
          </thead>
          <tbody>
            {redemptions.map((r) => (
              <tr key={r.id}>
                <td className={styles.left}>{formatDateTime(r.createdAt)}</td>
                <td className={`${styles.left} ${styles.mono}`}>{r.orderNumber}</td>
                <td className={styles.left}>{r.customerName || r.customerEmail || r.userId}</td>
                <td className={`${styles.right} tnum`}>
                  {r.orderTotalCents !== null ? formatBRL(r.orderTotalCents) : "—"}
                </td>
                <td className={`${styles.right} ${styles.discount} tnum`}>
                  -{formatBRL(r.discountCents)}
                </td>
              </tr>
            ))}
            {redemptions.length === 0 && (
              <tr>
                <td colSpan={5} className={styles.emptyCell}>
                  Este cupom ainda não foi utilizado em nenhum pedido.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

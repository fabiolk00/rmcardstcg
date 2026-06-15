import { CheckoutView } from "@/components/checkout/CheckoutView";
import styles from "./checkout.module.css";

export default function CheckoutPage() {
  return (
    <section>
      <h1 className={styles.title}>Finalizar compra</h1>
      <CheckoutView />
    </section>
  );
}

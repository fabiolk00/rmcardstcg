import { formatAddressOneLine } from "@/lib/data/address";
import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";

import type { Order } from "@/lib/data/types";
import { formatBRL } from "@/lib/utils/currency";

import { formatCep, paymentMethodLabel, shippingLabel } from "./orderEmailFormat";

/**
 * Template transacional (React Email). Um so componente cobre as duas mensagens
 * do MVP via `kind`: "created" (pedido recebido) e "paid" (pagamento confirmado).
 * Paleta monocromatica em hex (e-mail nao usa CSS vars), coerente com a loja.
 *
 * Linhas de valores espelham a formula do pedido (types.ts): total = subtotal
 * - desconto de produto - desconto de CUPOM + frete — o cupom tem linha propria
 * (com o codigo), senao as linhas nao fecham com o total.
 */
export type OrderEmailKind = "created" | "paid";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://rmcardstcg.com.br").replace(
  /\/$/,
  "",
);

export function OrderEmail({ order, kind }: { order: Order; kind: OrderEmailKind }) {
  const paid = kind === "paid";
  const title = paid
    ? `Pagamento confirmado — pedido ${order.id}`
    : `Pedido ${order.id} recebido`;
  const intro = paid
    ? "Recebemos seu pagamento e seu pedido já entrou em separação. Você receberá o código de rastreio assim que ele for despachado."
    : "Recebemos seu pedido. Assim que o pagamento for confirmado, iniciamos a separação.";

  return (
    <Html lang="pt-BR">
      <Head />
      <Preview>{title}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={brand}>RM Cards</Heading>

          {paid && <Text style={badge}>✓ PAGAMENTO CONFIRMADO</Text>}
          <Text style={h2}>{title}</Text>
          <Text style={p}>Olá, {order.customerName}.</Text>
          <Text style={p}>{intro}</Text>

          <Hr style={hr} />
          <Section>
            {order.items.map((it, i) => (
              <Row key={i} style={row}>
                <Column style={cell}>
                  {it.productName} × {it.quantity}
                </Column>
                <Column style={cellRight}>{formatBRL(it.unitPriceCents * it.quantity)}</Column>
              </Row>
            ))}
          </Section>

          <Hr style={hr} />
          <Row style={row}>
            <Column style={cell}>Subtotal</Column>
            <Column style={cellRight}>{formatBRL(order.subtotalCents)}</Column>
          </Row>
          {order.discountCents > 0 && (
            <Row style={row}>
              <Column style={cell}>Desconto</Column>
              <Column style={cellRight}>- {formatBRL(order.discountCents)}</Column>
            </Row>
          )}
          {order.couponDiscountCents > 0 && (
            <Row style={row}>
              <Column style={cell}>
                Cupom{order.couponCode ? ` (${order.couponCode})` : ""}
              </Column>
              <Column style={cellRight}>- {formatBRL(order.couponDiscountCents)}</Column>
            </Row>
          )}
          <Row style={row}>
            <Column style={cell}>{shippingLabel(order.shippingService, order.shippingDays)}</Column>
            <Column style={cellRight}>
              {order.shippingCents === 0 ? "Grátis" : formatBRL(order.shippingCents)}
            </Column>
          </Row>
          <Row style={totalRow}>
            <Column style={cellStrong}>Total</Column>
            <Column style={cellRightStrong}>{formatBRL(order.totalCents)}</Column>
          </Row>
          <Text style={muted}>Pagamento via {paymentMethodLabel(order.paymentMethod)}.</Text>

          <Section style={ctaSection}>
            <Button href={`${APP_URL}/minhas-compras`} style={cta}>
              Acompanhar meu pedido
            </Button>
          </Section>

          <Hr style={hr} />
          <Text style={muted}>
            Entrega para {formatAddressOneLine(order.address)}, CEP{" "}
            {formatCep(order.address.cep)}.
          </Text>
          <Text style={muted}>
            Dúvidas sobre o pedido? Fale com a gente em{" "}
            <Link href={APP_URL} style={footerLink}>
              rmcardstcg.com.br
            </Link>
            .
          </Text>
          <Text style={muted}>RM Cards — Pokémon TCG</Text>
        </Container>
      </Body>
    </Html>
  );
}

export default OrderEmail;

const body = { backgroundColor: "#f5f5f5", fontFamily: "Arial, Helvetica, sans-serif" };
const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "32px",
  maxWidth: "560px",
  border: "1px solid #e5e5e5",
  borderRadius: "8px",
};
const brand = { fontSize: "22px", fontWeight: "bold", color: "#1a1a1a", margin: "0 0 16px" };
const badge = {
  display: "inline-block",
  fontSize: "11px",
  fontWeight: "bold" as const,
  letterSpacing: "1px",
  color: "#ffffff",
  backgroundColor: "#1a1a1a",
  padding: "4px 10px",
  borderRadius: "4px",
  margin: "0 0 12px",
};
const h2 = { fontSize: "16px", fontWeight: "bold", color: "#1a1a1a", margin: "0 0 12px" };
const p = { fontSize: "14px", lineHeight: "22px", color: "#333333", margin: "0 0 8px" };
const hr = { borderColor: "#e5e5e5", margin: "20px 0" };
const row = { marginBottom: "6px" };
const cell = { fontSize: "14px", color: "#333333" };
const cellRight = { fontSize: "14px", color: "#1a1a1a", textAlign: "right" as const };
const cellStrong = { ...cell, fontWeight: "bold" as const, color: "#1a1a1a" };
const cellRightStrong = { ...cellRight, fontWeight: "bold" as const };
const totalRow = { marginTop: "8px" };
const ctaSection = { textAlign: "center" as const, margin: "24px 0 4px" };
const cta = {
  backgroundColor: "#1a1a1a",
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: "bold" as const,
  padding: "12px 24px",
  borderRadius: "6px",
  textDecoration: "none",
};
const footerLink = { color: "#777777", textDecoration: "underline" };
const muted = { fontSize: "12px", color: "#777777", margin: "0 0 4px" };

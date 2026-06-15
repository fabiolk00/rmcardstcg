import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";

import type { Order } from "@/lib/data/types";
import { formatBRL } from "@/lib/utils/currency";

/**
 * Template transacional (React Email). Um so componente cobre as duas mensagens
 * do MVP via `kind`: "created" (pedido recebido) e "paid" (pagamento confirmado).
 * Paleta monocromatica em hex (e-mail nao usa CSS vars).
 */
export type OrderEmailKind = "created" | "paid";

export function OrderEmail({ order, kind }: { order: Order; kind: OrderEmailKind }) {
  const paid = kind === "paid";
  const title = paid ? `Pagamento confirmado — pedido ${order.id}` : `Pedido ${order.id} recebido`;
  const intro = paid
    ? "Recebemos seu pagamento. Seu pedido entrou em separacao e voce sera avisado quando for enviado."
    : "Recebemos seu pedido. Assim que o pagamento via PIX for confirmado, iniciamos a separacao.";

  return (
    <Html lang="pt-BR">
      <Head />
      <Preview>{title}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={brand}>RM Cards</Heading>
          <Text style={h2}>{title}</Text>
          <Text style={p}>Ola, {order.customerName}.</Text>
          <Text style={p}>{intro}</Text>

          <Hr style={hr} />
          <Section>
            {order.items.map((it, i) => (
              <Row key={i} style={row}>
                <Column style={cell}>
                  {it.productName} x {it.quantity}
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
          <Row style={row}>
            <Column style={cell}>Frete</Column>
            <Column style={cellRight}>
              {order.shippingCents === 0 ? "Gratis" : formatBRL(order.shippingCents)}
            </Column>
          </Row>
          <Row style={totalRow}>
            <Column style={cell}>Total</Column>
            <Column style={cellRight}>{formatBRL(order.totalCents)}</Column>
          </Row>

          <Hr style={hr} />
          <Text style={muted}>
            Entrega para {order.address.street}, {order.address.city}-{order.address.state}, CEP{" "}
            {order.address.cep}.
          </Text>
          <Text style={muted}>RM Cards — Pokemon TCG</Text>
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
const h2 = { fontSize: "16px", fontWeight: "bold", color: "#1a1a1a", margin: "0 0 12px" };
const p = { fontSize: "14px", lineHeight: "22px", color: "#333333", margin: "0 0 8px" };
const hr = { borderColor: "#e5e5e5", margin: "20px 0" };
const row = { marginBottom: "6px" };
const cell = { fontSize: "14px", color: "#333333" };
const cellRight = { fontSize: "14px", color: "#1a1a1a", textAlign: "right" as const };
const totalRow = { marginTop: "8px", fontWeight: "bold" };
const muted = { fontSize: "12px", color: "#777777", margin: "0 0 4px" };

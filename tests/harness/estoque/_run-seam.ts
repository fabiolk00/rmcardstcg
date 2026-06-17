/**
 * RUNNER de SEAM (INFRA do harness) — executa uma funcao server-side de lib/data
 * num processo `tsx` separado e devolve o resultado como JSON na stdout.
 *
 * POR QUE existe (caveat tecnico do harness): o cliente Prisma gerado em
 * lib/generated/prisma/client.ts e ESM puro (usa `import.meta.url`). O runner de
 * testes do Playwright transpila os specs (e seus imports) para CJS via esbuild,
 * onde `import.meta` e SyntaxError — entao importar lib/data/* DIRETO no spec
 * quebra no load. `tsx` (ja usado pelo proprio runner do harness p/ seed e
 * apply-test-constraints) lida com esse ESM sem problema. Logo, o spec NAO importa
 * lib/data; ele dispara este runner via `spawnSync('tsx', ...)`, herdando
 * process.env.DATABASE_URL, e depois assertaa o estado real do banco via `pg`.
 *
 * Isto e exclusivamente INFRA de teste — nenhum codigo de produto e tocado. As
 * funcoes invocadas sao as MESMAS seams de producao (lib/data/products etc.).
 *
 * Protocolo: argv[2] = nome da operacao; SEAM_PAYLOAD (env) = JSON de entrada.
 *   SEAM_PAYLOAD='{"actor":{...},"input":{...}}' tsx _run-seam.ts createProduct
 * (env, nao argv, p/ nao depender do quoting de JSON pelo shell do Windows.)
 * Saida (stdout): linha unica `__SEAM_RESULT__<json>` em caso de sucesso, ou
 *   `__SEAM_ERROR__<json com {name,message}>` em caso de erro de dominio.
 * Exit code 0 sempre que o protocolo foi cumprido (sucesso OU erro de dominio
 * capturado); != 0 so para falhas inesperadas de processo.
 */
import {
  createProduct,
  setProductActive,
  updateProduct,
  type ProductInput,
} from "../../../lib/data/products";
import {
  adjustOrderPaymentStatus,
  applyPaymentStatusTx,
  updateOrderInternalNote,
  updateOrderShippingStatus,
  type PaymentRef,
} from "../../../lib/data/orders";
import {
  createCoupon,
  updateCoupon,
  setCouponActive,
  deleteCoupon,
  redeemCoupon,
  type CouponInput,
} from "../../../lib/data/coupons";
import type { PaymentStatus, ShippingStatus } from "../../../lib/data/types";
import type { AuditActor } from "../../../lib/data/audit";
import { finalPriceCents } from "../../../lib/data/pricing";
import {
  cartTotals,
  FREE_SHIPPING_THRESHOLD_CENTS,
  FLAT_SHIPPING_CENTS,
  type CartLine,
} from "../../../lib/cart/totals";
import { prisma } from "../../../lib/db";
import {
  commitStock,
  releaseStock,
  reserveStock,
  restockUnits,
  type StockItem,
} from "../../../lib/data/inventory";

type CreateArgs = { actor: AuditActor; input: ProductInput };
type UpdateArgs = { actor: AuditActor; id: string; input: ProductInput };
// Soft-delete / reativacao de produto: chama setProductActive(actor, id, isActive)
// de PRODUCAO (lib/data/products.ts). A funcao roda prisma.$transaction { le before,
// no-op idempotente se ja no estado pedido, senao UPDATE is_active + writeAuditLog
// (action product.inactivate quando isActive=false, product.reactivate quando true)
// na MESMA tx }. A spec dispara esta seam e asserta o estado real via pg. INFRA de
// teste: usa a funcao de PRODUCAO sem mock — espelha o que setProductActiveAction
// (app/admin/produtos/actions.ts) delega apos requireAdmin().
type SetActiveArgs = { actor: AuditActor; id: string; isActive: boolean };
// Espelha o call site de PRODUCAO (createPendingOrderWithReservation, orders.ts
// L193-221): numa MESMA transacao, chama reserveStock(tx, items) e — se ok —
// vira a flag stockReserved=true do pedido. Se reserveStock devolver ok:false, o
// throw aborta a transacao (rollback total), exatamente como o checkout faz com
// OutOfStockError. INFRA de teste: usa as funcoes de PRODUCAO sem mock.
type ReserveArgs = { orderId: number; items: StockItem[] };
// Espelha o ramo 'paid' de reconcileStockForPaymentStatus (orders.ts L448-454):
// numa MESMA transacao, faz o CAS da flag (stock_committed=true, stock_reserved=
// false WHERE stock_reserved=true AND stock_committed=false) e — SE o CAS reivindicou
// a linha (claimed===1) — chama commitStock(tx, lines). As `lines` sao lidas dos
// PROPRIOS itens do pedido (snap.items na producao), nao injetadas. Devolve
// { claimed } p/ a spec provar idempotencia/efeito. INFRA de teste: usa as funcoes
// de PRODUCAO (commitStock) e o MESMO CAS do reconcile, sem mock.
type CommitArgs = { orderId: number };
// Espelha o ramo 'cancelled' (estorno de reserva) de reconcileStockForPaymentStatus
// (orders.ts L457-466): numa MESMA transacao, faz o CAS da flag
//   UPDATE "orders" SET stock_reserved=false
//   WHERE id=? AND stock_reserved=true AND stock_committed=false
// e — SE released===1 — chama releaseStock(tx, lines) (reserved -= qty; stock
// INTOCADO). As `lines` saem dos PROPRIOS itens do pedido (como snap.items no
// reconcile), nao injetadas. Devolve { released } p/ a spec provar efeito/
// idempotencia. INFRA de teste: usa a funcao de PRODUCAO (releaseStock) e o MESMO
// CAS do reconcile, sem mock.
type ReleaseArgs = { orderId: number };
// Espelha o RAMO DE REFUND DE PEDIDO JA PAGO de reconcileStockForPaymentStatus
// (orders.ts L467-473): quando o CAS de release NAO reivindica (pedido nao estava
// apenas reservado), o reconcile cai no ramo de refund — numa MESMA transacao faz o
// CAS da flag:
//   UPDATE "orders" SET stock_committed=false
//   WHERE id=? AND stock_committed=true
// e — SE refunded===1 — chama restockUnits(tx, lines) (stock += qty; reserved
// INTOCADO). As `lines` saem dos PROPRIOS itens do pedido (como snap.items no
// reconcile), nao injetadas. Devolve { refunded } p/ a spec provar efeito/
// idempotencia. INFRA de teste: usa a funcao de PRODUCAO (restockUnits) e o MESMO
// CAS do reconcile, sem mock.
type RestockArgs = { orderId: number };
// Seam PURA: chama finalPriceCents(p) de PRODUCAO (lib/data/pricing.ts) com
// { priceCents, discountPct } e devolve o numero derivado. Este case NAO toca
// prisma nem o banco — exatamente por isso prova a invariante pure-client-safe:
// a funcao computa o preco final isolada de qualquer dependencia server-only.
// INFRA de teste: usa a funcao de PRODUCAO sem mock.
type FinalPriceArgs = { priceCents: number; discountPct: number };
// Seam PURA: chama cartTotals(lines) de PRODUCAO (lib/cart/totals.ts) com linhas
// de carrinho montadas pela spec e devolve o CartTotals computado JUNTO com as
// CONSTANTES de PRODUCAO (FREE_SHIPPING_THRESHOLD_CENTS, FLAT_SHIPPING_CENTS) lidas
// do MESMO modulo. Este case NAO toca prisma nem o banco — cartTotals e a funcao
// pura de checkout que decide frete gratis (mercadoria ja com desconto >= limite),
// frete flat (abaixo do limite) e total. Devolver as constantes junto deixa a spec
// asserir contra os limites REAIS de producao, nao contra numeros magicos copiados.
// INFRA de teste: usa a funcao de PRODUCAO sem mock.
type CartTotalsArgs = { lines: CartLine[] };
// Espelha o call site de PRODUCAO do AJUSTE MANUAL DE PAGAMENTO pelo admin
// (adjustOrderPaymentStatusAction -> adjustOrderPaymentStatus, lib/data/orders.ts
// L624). Numa MESMA transacao a funcao: le o pedido (before), valida X->X no-op,
// faz o CAS de payment_status, concilia o estoque via reconcileStockForPaymentStatus
// (ramo 'paid' = commitStock; 'cancelled' = release/refund) e grava audit_log
// (action order.payment_status_update, after.manualAdjustment=true/adjustmentReason)
// — tudo na mesma tx. A server action so DELEGA apos requireAdmin() (contexto de
// request), por isso chamamos a funcao de lib/data direto. INFRA de teste: usa a
// funcao de PRODUCAO sem mock; a spec assertaa o estado real via pg.
type AdjustPaymentArgs = {
  orderId: number;
  to: PaymentStatus;
  reason: string;
  actor: AuditActor;
};
// Espelha o NUCLEO da maquina de pagamento de PRODUCAO usada pelo webhook/reconcile
// (applyPaymentStatusTx, lib/data/orders.ts L332). Recebe um `tx` externo na
// producao; aqui o envelopamos num prisma.$transaction EXATAMENTE como o wrapper de
// PRODUCAO setOrderPaymentStatus (orders.ts L411-420) faz para chamadores sem tx
// proprio. A funcao valida a transicao contra PAYMENT_TRANSITIONS ANTES de qualquer
// efeito de estoque: uma transicao ilegal (ex.: paid->pending, cancelled->paid)
// retorna { found:true, ok:false, reason:'invalid_transition' } SEM tocar estoque e
// SEM gravar audit (a guarda retorna antes de reconcileStockForPaymentStatus; a
// propria applyPaymentStatusTx nunca escreve audit_log). A verificacao anti-replay
// exige payment.id == orders.asaas_payment_id, entao a spec seta asaas_payment_id no
// pedido e passa o `payment.id` casado p/ exercitar o ramo invalid_transition (e nao
// payment_mismatch). INFRA de teste: usa a funcao de PRODUCAO sem mock; a spec
// inspeciona o retorno E assertaa o estado real via pg.
type ApplyPaymentArgs = {
  orderId: number;
  status: PaymentStatus;
  payment: PaymentRef;
};
// Espelha o call site de PRODUCAO da MAQUINA DE ENVIO pelo admin
// (updateOrderShippingStatusAction -> updateOrderShippingStatus, lib/data/orders.ts
// L523). Numa MESMA transacao a funcao: le o pedido (before), trata X->X no-op,
// valida a transicao contra SHIPPING_TRANSITIONS (transicao ilegal devolve
// { ok:false, reason:'invalid_transition', from, to } SEM gravar nada), aplica via
// compare-and-swap atomico (updateMany WHERE shippingStatus=from), concilia o estoque
// SO quando to==='cancelled' (reconcileStockForPaymentStatus) e grava audit_log
// (action order.shipping_status_update, before/after snapshots) — tudo na mesma tx. A
// server action so DELEGA apos requireAdmin() (contexto de request), por isso chamamos
// a funcao de lib/data direto. INFRA de teste: usa a funcao de PRODUCAO sem mock; a
// spec assertaa o estado real via pg.
type ShippingArgs = {
  orderId: number;
  to: ShippingStatus;
  actor: AuditActor;
};
// Espelha o call site de PRODUCAO da NOTA INTERNA do pedido pelo admin
// (updateOrderInternalNoteAction -> updateOrderInternalNote, lib/data/orders.ts L579).
// Numa MESMA transacao a funcao: normaliza note (string vazia/so-espacos -> null), le o
// pedido (before, adminOrderSelect), trata no-op quando (existing.internalNote ?? null)
// === normalized (devolve changed:false SEM audit), senao faz UPDATE internalNote e
// grava audit_log (action order.note_update, before/after snapshots) — tudo na mesma tx.
// A server action so DELEGA apos requireAdmin() (contexto de request), por isso chamamos
// a funcao de lib/data direto. INFRA de teste: usa a funcao de PRODUCAO sem mock; a spec
// assertaa o estado real via pg.
type NoteArgs = {
  orderId: number;
  note: string | null;
  actor: AuditActor;
};
// Espelha o call site de PRODUCAO da CRIACAO DE CUPOM pelo admin
// (createCouponAction -> createCoupon, lib/data/coupons.ts L150). Numa MESMA
// prisma.$transaction a funcao: normaliza o CouponInput via toCouponData (zera o
// campo do tipo oposto — percent zera valueCents, fixed zera percentOff; codigo em
// UPPER), faz tx.coupon.create e grava audit_log (action coupon.create, before=null,
// after=snapshot do cupom) — tudo na mesma tx. Codigo duplicado (P2002) vira
// { ok:false, error }. A server action so DELEGA apos requireAdmin() (contexto de
// request), por isso chamamos a funcao de lib/data direto. INFRA de teste: usa a
// funcao de PRODUCAO sem mock; a spec assertaa o estado real via pg.
type CreateCouponArgs = { actor: AuditActor; input: CouponInput };
// Espelha o call site de PRODUCAO da EDICAO DE CUPOM pelo admin
// (updateCouponAction -> updateCoupon, lib/data/coupons.ts L179). Numa MESMA
// prisma.$transaction a funcao: le o cupom (before), normaliza o CouponInput via
// toCouponData (mesma coerencia tipo<->campo do create; NUNCA toca redeemedCount —
// nao ha redeemedCount em CouponInput nem em toCouponData), faz tx.coupon.update e
// grava audit_log (action coupon.update, before/after = snapshots do dominio) — tudo
// na mesma tx. Cupom inexistente -> { ok:false, error }; codigo duplicado (P2002) ->
// { ok:false, error }. A server action so DELEGA apos requireAdmin() (contexto de
// request), por isso chamamos a funcao de lib/data direto. INFRA de teste: usa a
// funcao de PRODUCAO sem mock; a spec assertaa o estado real via pg.
type UpdateCouponArgs = { actor: AuditActor; id: string; input: CouponInput };
// Espelha o call site de PRODUCAO de ATIVAR/INATIVAR CUPOM pelo admin
// (setCouponActiveAction -> setCouponActive, lib/data/coupons.ts L213). Numa MESMA
// prisma.$transaction a funcao: le o cupom (before), faz tx.coupon.update apenas do
// campo isActive e grava audit_log na mesma tx — com action coupon.deactivate quando
// isActive=false (cupom sai de circulacao sem ser apagado) e coupon.update quando
// isActive=true (religar). before/after = snapshots do dominio. Cupom inexistente ->
// { ok:false, error }. A server action so DELEGA apos requireAdmin() (contexto de
// request), por isso chamamos a funcao de lib/data direto. INFRA de teste: usa a
// funcao de PRODUCAO sem mock; a spec assertaa o estado real via pg.
type SetCouponActiveArgs = { actor: AuditActor; id: string; isActive: boolean };
// Espelha o call site de PRODUCAO da EXCLUSAO DE CUPOM pelo admin
// (deleteCouponAction -> deleteCoupon, lib/data/coupons.ts L257). Numa MESMA
// prisma.$transaction a funcao: le o cupom (before); se inexistente -> 'not_found';
// conta coupon_redemptions WHERE coupon_id=id e, se > 0, retorna 'in_use' SEM apagar
// (guarda de integridade — historico financeiro protegido pela FK onDelete: Restrict);
// senao faz tx.coupon.delete (hard-delete, o 'D' do CRUD) e grava audit_log
// (action coupon.delete, before=snapshot, after=null) na MESMA tx. Corrida (redencao
// inserida entre a contagem e o delete) dispara FK Restrict P2003, tratada como 'in_use'.
// Devolve o CouponDeleteResult ({ ok:true, id } | { ok:false, error }). A server action
// so DELEGA apos requireAdmin() (contexto de request), por isso chamamos a funcao de
// lib/data direto. INFRA de teste: usa a funcao de PRODUCAO sem mock; a spec assertaa o
// estado real via pg.
type DeleteCouponArgs = { actor: AuditActor; id: string };
// Espelha o call site de PRODUCAO da REDENCAO DE CUPOM no checkout
// (placeOrder/confirmacao -> redeemCoupon, lib/data/coupons.ts L364). redeemCoupon
// recebe um `tx` externo na PRODUCAO (corre DENTRO da transacao do checkout); aqui o
// envelopamos num prisma.$transaction EXATAMENTE como o checkout faz com sua propria
// $transaction. Dentro da tx a funcao: (1) verifica idempotencia por pedido
// (coupon_redemptions.order_id UNIQUE — se ja existe, alreadyRedeemed:true, no-op);
// (2) se perUserLimit!=null, pega advisory lock (cupom,usuario) e reconta; (3) faz o
// increment ATOMICO do limite global via updateMany WHERE id=cupom AND
// (max IS NULL OR redeemed_count < max) — count==0 => esgotado, retorna
// { ok:false, reason:'max_redemptions' } SEM inserir; (4) senao insere a linha em
// coupon_redemptions. Quando a redencao FALHA (ok:false) o checkout de PRODUCAO aborta
// a transacao inteira (rollback) — espelhamos isso lancando RedeemAbort, re-emitindo o
// resultado { ok:false } apos o rollback (nada parcial persiste). Quando ok:true a tx
// commita. INFRA de teste: usa a funcao de PRODUCAO sem mock; a spec assertaa o estado
// real via pg.
type RedeemCouponArgs = {
  couponId: string;
  orderId: number;
  userId: string;
  discountCents: number;
  perUserLimit: number | null;
  maxRedemptions: number | null;
};

/**
 * Erro de aborto da reserva — carrega o resultado { ok:false, productId } do
 * reserveStock p/ FORCAR o rollback da $transaction (espelha OutOfStockError do
 * checkout). O resultado e re-emitido como __SEAM_RESULT__ apos a transacao
 * abortar, p/ a spec inspecionar { ok:false } E provar que nada foi gravado.
 */
class ReserveAbort extends Error {
  readonly result: { ok: false; productId: string };
  constructor(result: { ok: false; productId: string }) {
    super("reserve_abort");
    this.name = "ReserveAbort";
    this.result = result;
  }
}

/**
 * Aborto da redencao — carrega o resultado { ok:false, reason } do redeemCoupon p/
 * FORCAR o rollback da $transaction (espelha o checkout de PRODUCAO, que aborta a
 * transacao inteira quando a redencao falha). O resultado e re-emitido como
 * __SEAM_RESULT__ apos a transacao abortar, p/ a spec inspecionar { ok:false } E
 * provar que nada foi gravado (sem increment parcial, sem linha em coupon_redemptions).
 */
class RedeemAbort extends Error {
  readonly result: { ok: false; reason: string };
  constructor(result: { ok: false; reason: string }) {
    super("redeem_abort");
    this.name = "RedeemAbort";
    this.result = result;
  }
}

async function main(): Promise<void> {
  const op = process.argv[2];
  const payload = JSON.parse(process.env.SEAM_PAYLOAD ?? "{}");

  try {
    let result: unknown;
    switch (op) {
      case "createProduct": {
        const { actor, input } = payload as CreateArgs;
        result = await createProduct(actor, input);
        break;
      }
      case "updateProduct": {
        const { actor, id, input } = payload as UpdateArgs;
        result = await updateProduct(actor, id, input);
        break;
      }
      case "setProductActive": {
        // Soft-delete (isActive=false) / reativacao (true) auditada na MESMA tx,
        // via a funcao de PRODUCAO. Devolve o Product resultante (ou o before, se no-op).
        const { actor, id, isActive } = payload as SetActiveArgs;
        result = await setProductActive(actor, id, isActive);
        break;
      }
      case "reserveStockForOrder": {
        // Reserva atomica + flag do pedido na MESMA transacao (mesmo padrao do
        // checkout de producao). Devolve o resultado cru do reserveStock.
        const { orderId, items } = payload as ReserveArgs;
        result = await prisma.$transaction(async (tx) => {
          const reserve = await reserveStock(tx, items);
          if (!reserve.ok) {
            // Sinaliza p/ rollback (como o checkout faz com OutOfStockError); o
            // payload do resultado vai junto p/ a spec inspecionar { ok:false }.
            throw new ReserveAbort(reserve);
          }
          await tx.order.update({
            where: { id: orderId },
            data: { stockReserved: true, stockCommitted: false },
          });
          return reserve;
        });
        break;
      }
      case "commitStockForOrder": {
        // Baixa definitiva na confirmacao do pagamento, na MESMA transacao, com o
        // MESMO compare-and-swap idempotente do reconcile de producao (ramo 'paid'):
        //   CAS WHERE stock_reserved=true AND stock_committed=false vira as flags;
        //   so quando claimed===1 (a tx reivindicou a transicao) commitStock roda.
        // As `lines` saem dos PROPRIOS itens do pedido (como snap.items em
        // reconcileStockForPaymentStatus), nao de um payload injetado.
        const { orderId } = payload as CommitArgs;
        result = await prisma.$transaction(async (tx) => {
          const order = await tx.order.findUnique({
            where: { id: orderId },
            select: { items: { select: { productId: true, quantity: true } } },
          });
          const lines = (order?.items ?? []).map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
          }));
          const claimed = await tx.$executeRaw`
            UPDATE "orders" SET "stock_committed" = true, "stock_reserved" = false
            WHERE "id" = ${orderId} AND "stock_reserved" = true AND "stock_committed" = false
          `;
          if (claimed === 1) await commitStock(tx, lines);
          return { claimed: Number(claimed) };
        });
        break;
      }
      case "releaseStockForOrder": {
        // Estorno da reserva no cancelamento de pedido PENDENTE (nao pago), na MESMA
        // transacao, com o MESMO compare-and-swap idempotente do reconcile de
        // producao (ramo 'cancelled' -> release):
        //   CAS WHERE stock_reserved=true AND stock_committed=false vira stock_reserved
        //   p/ false; so quando released===1 (a tx reivindicou a transicao) releaseStock
        //   roda (reserved -= qty; stock INTOCADO).
        // As `lines` saem dos PROPRIOS itens do pedido (como snap.items em
        // reconcileStockForPaymentStatus), nao de um payload injetado.
        const { orderId } = payload as ReleaseArgs;
        result = await prisma.$transaction(async (tx) => {
          const order = await tx.order.findUnique({
            where: { id: orderId },
            select: { items: { select: { productId: true, quantity: true } } },
          });
          const lines = (order?.items ?? []).map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
          }));
          const released = await tx.$executeRaw`
            UPDATE "orders" SET "stock_reserved" = false
            WHERE "id" = ${orderId} AND "stock_reserved" = true AND "stock_committed" = false
          `;
          if (released === 1) await releaseStock(tx, lines);
          return { released: Number(released) };
        });
        break;
      }
      case "restockUnitsForOrder": {
        // Reposicao de estoque no REFUND de pedido JA PAGO (stock_committed=true), na
        // MESMA transacao, com o MESMO compare-and-swap idempotente do reconcile de
        // producao (ramo 'cancelled' -> refund de pago):
        //   CAS WHERE stock_committed=true vira stock_committed p/ false; so quando
        //   refunded===1 (a tx reivindicou a transicao) restockUnits roda (stock +=
        //   qty; reserved INTOCADO).
        // As `lines` saem dos PROPRIOS itens do pedido (como snap.items em
        // reconcileStockForPaymentStatus), nao de um payload injetado.
        const { orderId } = payload as RestockArgs;
        result = await prisma.$transaction(async (tx) => {
          const order = await tx.order.findUnique({
            where: { id: orderId },
            select: { items: { select: { productId: true, quantity: true } } },
          });
          const lines = (order?.items ?? []).map((it) => ({
            productId: it.productId,
            quantity: it.quantity,
          }));
          const refunded = await tx.$executeRaw`
            UPDATE "orders" SET "stock_committed" = false
            WHERE "id" = ${orderId} AND "stock_committed" = true
          `;
          if (refunded === 1) await restockUnits(tx, lines);
          return { refunded: Number(refunded) };
        });
        break;
      }
      case "finalPriceCents": {
        // Seam PURA — chama a funcao de PRODUCAO finalPriceCents diretamente, SEM
        // abrir transacao nem tocar o banco. O resultado e o preco final derivado
        // em centavos (Int). Prova final-price-derived + pure-client-safe.
        const { priceCents, discountPct } = payload as FinalPriceArgs;
        result = finalPriceCents({ priceCents, discountPct });
        break;
      }
      case "cartTotals": {
        // Seam PURA — chama a funcao de PRODUCAO cartTotals diretamente, SEM abrir
        // transacao nem tocar o banco. Devolve o CartTotals computado MAIS as
        // constantes de PRODUCAO (threshold de frete gratis e frete flat), p/ a spec
        // asserir frete-gratis-acima-do-limite contra os limites REAIS do checkout.
        const { lines } = payload as CartTotalsArgs;
        result = {
          totals: cartTotals(lines),
          FREE_SHIPPING_THRESHOLD_CENTS,
          FLAT_SHIPPING_CENTS,
        };
        break;
      }
      case "adjustOrderPaymentStatus": {
        // Ajuste manual de pagamento pelo admin (transicao + conciliacao de estoque +
        // audit na MESMA tx), via a funcao de PRODUCAO. Devolve o AdminOrderUpdate
        // ({ ok, changed, order } | { ok:false, reason }); a spec assertaa via pg.
        const { orderId, to, reason, actor } = payload as AdjustPaymentArgs;
        result = await adjustOrderPaymentStatus(orderId, to, reason, actor);
        break;
      }
      case "applyPaymentStatus": {
        // Nucleo da maquina de pagamento (webhook/reconcile). Envelopa
        // applyPaymentStatusTx num $transaction como o wrapper de PRODUCAO
        // setOrderPaymentStatus. Devolve o PaymentStatusUpdate (incl. o ramo
        // { found:true, ok:false, reason:'invalid_transition' }); a spec assertaa
        // o estado real via pg (nada gravado em estoque/audit numa transicao ilegal).
        const { orderId, status, payment } = payload as ApplyPaymentArgs;
        result = await prisma.$transaction(
          (tx) => applyPaymentStatusTx(tx, orderId, status, payment),
          { timeout: 15000, maxWait: 5000 },
        );
        break;
      }
      case "updateOrderShippingStatus": {
        // Maquina de envio do admin (transicao validada + audit na MESMA tx; estoque
        // so e conciliado em to==='cancelled'), via a funcao de PRODUCAO. Devolve o
        // AdminOrderUpdate ({ ok, changed, order } | { ok:false, reason, from?, to? });
        // a spec assertaa o estado real via pg.
        const { orderId, to, actor } = payload as ShippingArgs;
        result = await updateOrderShippingStatus(orderId, to, actor);
        break;
      }
      case "updateOrderInternalNote": {
        // Nota interna do admin (normaliza vazio->null; grava audit order.note_update na
        // MESMA tx; no-op idempotente quando a nota normalizada e identica), via a funcao
        // de PRODUCAO. Devolve o AdminOrderUpdate ({ ok, changed, order } | { ok:false,
        // reason }); a spec assertaa o estado real via pg.
        const { orderId, note, actor } = payload as NoteArgs;
        result = await updateOrderInternalNote(orderId, note, actor);
        break;
      }
      case "createCoupon": {
        // Criacao de cupom pelo admin (coerencia tipo<->campo via toCouponData +
        // audit coupon.create na MESMA tx), via a funcao de PRODUCAO. Devolve o
        // CouponMutationResult ({ ok:true, coupon } | { ok:false, error }); a spec
        // assertaa o estado real via pg.
        const { actor, input } = payload as CreateCouponArgs;
        result = await createCoupon(actor, input);
        break;
      }
      case "updateCoupon": {
        // Edicao de cupom pelo admin (coerencia tipo<->campo via toCouponData +
        // audit coupon.update na MESMA tx; NUNCA toca redeemedCount), via a funcao
        // de PRODUCAO. Devolve o CouponMutationResult ({ ok:true, coupon } |
        // { ok:false, error }); a spec assertaa o estado real via pg.
        const { actor, id, input } = payload as UpdateCouponArgs;
        result = await updateCoupon(actor, id, input);
        break;
      }
      case "setCouponActive": {
        // Ativa/inativa cupom pelo admin (UPDATE is_active + audit na MESMA tx:
        // coupon.deactivate ao desligar, coupon.update ao religar), via a funcao de
        // PRODUCAO. Devolve o CouponMutationResult ({ ok:true, coupon } |
        // { ok:false, error }); a spec assertaa o estado real via pg.
        const { actor, id, isActive } = payload as SetCouponActiveArgs;
        result = await setCouponActive(actor, id, isActive);
        break;
      }
      case "deleteCoupon": {
        // Exclusao de cupom pelo admin (hard-delete SO se nunca redimido + audit
        // coupon.delete na MESMA tx; cupom usado -> { ok:false } pela guarda/FK Restrict),
        // via a funcao de PRODUCAO. Devolve o CouponDeleteResult ({ ok:true, id } |
        // { ok:false, error }); a spec assertaa o estado real via pg.
        const { actor, id } = payload as DeleteCouponArgs;
        result = await deleteCoupon(actor, id);
        break;
      }
      case "redeemCoupon": {
        // Redencao de cupom no checkout (idempotente por pedido + increment atomico do
        // limite global + recontagem por usuario sob advisory lock), via a funcao de
        // PRODUCAO. Envelopa redeemCoupon num $transaction como o checkout. Em ok:false
        // lanca RedeemAbort p/ abortar a tx (rollback total, como a producao); em ok:true
        // a tx commita. Devolve o RedeemResult; a spec assertaa o estado real via pg.
        const args = payload as RedeemCouponArgs;
        result = await prisma.$transaction(async (tx) => {
          const redeem = await redeemCoupon(tx, args);
          if (!redeem.ok) {
            // Sinaliza p/ rollback (como o checkout aborta a tx quando a redencao falha);
            // o payload do resultado vai junto p/ a spec inspecionar { ok:false }.
            throw new RedeemAbort(redeem);
          }
          return redeem;
        });
        break;
      }
      default:
        throw new Error(`operacao desconhecida: ${op}`);
    }
    process.stdout.write(`__SEAM_RESULT__${JSON.stringify(result)}\n`);
  } catch (err) {
    // Aborto intencional da reserva (ok:false): a transacao ja sofreu rollback;
    // re-emitimos o resultado como SUCESSO de protocolo p/ a spec assertaa.
    if (err instanceof ReserveAbort) {
      process.stdout.write(`__SEAM_RESULT__${JSON.stringify(err.result)}\n`);
      return;
    }
    // Aborto intencional da redencao (ok:false): a transacao ja sofreu rollback;
    // re-emitimos o resultado como SUCESSO de protocolo p/ a spec assertaa.
    if (err instanceof RedeemAbort) {
      process.stdout.write(`__SEAM_RESULT__${JSON.stringify(err.result)}\n`);
      return;
    }
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`__SEAM_ERROR__${JSON.stringify({ name, message })}\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[_run-seam] falha inesperada:", err);
    process.exit(1);
  });

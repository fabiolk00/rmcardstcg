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
import { createProduct, updateProduct, type ProductInput } from "../../../lib/data/products";
import type { AuditActor } from "../../../lib/data/audit";
import { finalPriceCents } from "../../../lib/data/pricing";
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

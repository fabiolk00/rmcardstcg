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
import { prisma } from "../../../lib/db";
import { reserveStock, type StockItem } from "../../../lib/data/inventory";

type CreateArgs = { actor: AuditActor; input: ProductInput };
type UpdateArgs = { actor: AuditActor; id: string; input: ProductInput };
// Espelha o call site de PRODUCAO (createPendingOrderWithReservation, orders.ts
// L193-221): numa MESMA transacao, chama reserveStock(tx, items) e — se ok —
// vira a flag stockReserved=true do pedido. Se reserveStock devolver ok:false, o
// throw aborta a transacao (rollback total), exatamente como o checkout faz com
// OutOfStockError. INFRA de teste: usa as funcoes de PRODUCAO sem mock.
type ReserveArgs = { orderId: number; items: StockItem[] };

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

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

type CreateArgs = { actor: AuditActor; input: ProductInput };
type UpdateArgs = { actor: AuditActor; id: string; input: ProductInput };

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
      default:
        throw new Error(`operacao desconhecida: ${op}`);
    }
    process.stdout.write(`__SEAM_RESULT__${JSON.stringify(result)}\n`);
  } catch (err) {
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

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { test, expect } from "@playwright/test";
import { Client } from "pg";

/**
 * FEATURE: chaos.coupon.delete-guard (priority 34, category=chaos) — DB-first, sem browser.
 *
 * Prova SOB ADVERSALIDADE/CONCORRENCIA REAL que um cupom COM historico de redencao
 * NUNCA pode ser excluido: deleteCoupon recusa (in_use); a corrida com uma redencao
 * concorrente vira P2003 (FK Restrict) tratado, jamais apaga; o caminho correto e
 * INATIVAR (setCouponActive false). Tudo contra o Postgres efemero REAL exposto em
 * process.env.DATABASE_URL pelo runner (scripts/harness-with-ephemeral-pg.ts).
 *
 * SEAMS escolhidas (todas funcoes de PRODUCAO, sem mock — _run-seam.ts ja as suporta):
 *  - createCoupon(actor,input)  (lib/data/coupons.ts L150) — semeia o cupom.
 *  - redeemCoupon(tx,input)     (lib/data/coupons.ts L364) — a MESMA funcao do checkout;
 *    insere 1 linha REAL em coupon_redemptions (FK order_id -> orders.id). E ela que cria
 *    o historico financeiro que a guarda protege; nao falseamos a linha na mao.
 *  - deleteCoupon(actor,id)     (lib/data/coupons.ts L257) — a funcao de MENOR NIVEL que
 *    carrega a guarda coupon-delete-guard. Numa MESMA prisma.$transaction: le o cupom
 *    (before); CONTA coupon_redemptions WHERE coupon_id=id e, se > 0, retorna 'in_use' SEM
 *    apagar e SEM audit; senao faria o hard-delete + audit coupon.delete. O catch trata
 *    P2003 (redencao inserida entre a contagem e o delete -> FK Restrict) como 'in_use'.
 *  - setCouponActive(actor,id,false) (lib/data/coupons.ts L213) — caminho correto: vira
 *    is_active=false e audita coupon.deactivate na MESMA tx (cupom sai de circulacao sem
 *    ser apagado).
 * NAO chamamos as server actions (deleteCouponAction etc.) porque comecam com
 * requireAdmin() (contexto de request: next/headers, Clerk), que quebra fora do HTTP; a
 * action so DELEGA para a funcao de lib/data, que e o que exercitamos.
 *
 * POR QUE ESTE TESTE FALHARIA SE O PRODUTO NAO FOSSE SEGURO (anti-fake-green):
 *  - FASE A (deletes concorrentes sobre historico ja existente): disparamos N>=10
 *    deleteCoupon SIMULTANEOS via `spawn` assincrono + Promise.all (NAO spawnSync, que
 *    serializaria e seria trivial), todos sobre o MESMO cupom que JA tem 1 redencao real.
 *    Se a guarda nao olhasse o HISTORICO (ex.: olhasse so um contador, ou nem checasse),
 *    algum delete passaria e a linha sumiria de coupons -> teste reprova (exige
 *    COUNT(coupons)==1 e 0 ok:true). Se a guarda nao fosse atomica/segura sob N processos,
 *    poderia haver apagamento parcial; exigimos que TODOS retornem in_use e o registro +
 *    historico sobrevivam.
 *  - FASE B (A CORRIDA do enunciado: delete x redeem concorrentes): para K cupons, cada um
 *    com 1 redencao "ancora" ja gravada, disparamos EM PARALELO REAL (Promise.all sobre
 *    spawn): 1 deleteCoupon + 1 redeemCoupon NOVO (outro pedido) do MESMO cupom. Como a
 *    ancora ja esta COMMITADA, a GUARDA DE APLICACAO (COUNT>=1) recusa o delete (in_use)
 *    em todo interleaving; o redeem concorrente so faz o historico crescer. Esta fase prova
 *    a CAMADA 1 (guarda de aplicacao) sob concorrencia real: se a guarda nao olhasse o
 *    historico, algum delete passaria e o cupom sumiria -> reprova (exige, p/ CADA cupom:
 *    COUNT(coupons)==1, redencoes >=1 e NUNCA decrescem, deleteCoupon sempre ok:false
 *    in_use, sem P-error, 0 audit coupon.delete).
 *  - FASE D (A REDE FINAL, deterministica): a CAMADA 2 — FK onDelete:Restrict -> P2003 ->
 *    in_use — que as fases A/B NAO alcancam (la o COUNT>=1 ja barra ANTES do tx.coupon.
 *    delete()). Forcamos a janela TOCTOU exata: uma 2a conexao segura uma redencao
 *    NAO-COMMITADA (lock FK-share na linha do cupom); deleteCoupon le COUNT=0 (invisivel
 *    sob READ COMMITTED), PASSA a guarda e BLOQUEIA no DELETE; ao detectar o bloqueio,
 *    commitamos a redencao -> o DELETE re-checa a RI RESTRICT -> P2003, traduzido em
 *    in_use. Se o catch de P2003 fosse removido do produto, o erro vazaria como erro de
 *    processo -> reprova. E o unico caminho que exercita o catch de P2003 em runtime.
 *
 * CAVEAT TECNICO (resolvido como INFRA do harness, sem tocar produto): o cliente Prisma
 * gerado e ESM puro (import.meta). O runner do Playwright transpila os specs para CJS,
 * onde import.meta e SyntaxError — importar lib/data DIRETO no spec quebra no load. Por
 * isso as MUTACOES rodam em processos `tsx` separados (tests/harness/estoque/_run-seam.ts),
 * herdando DATABASE_URL; o spec faz TODAS as assercoes via `pg`.
 *
 * Asserts canonicos da feature (4/4 provados via pg):
 *  A1 "deleteCoupon retorna ok:false (in_use): bloqueado pela FK Restrict; corrida vira
 *     P2003 tratado, nunca apaga": TODO deleteCoupon (sob delete concorrente E sob corrida
 *     com redeem) retorna ok:false com a mensagem 'Cupom ja foi utilizado...'; nenhum
 *     P-error (P2003/etc.) vaza; nenhum ok:true.
 *  A2 "A linha PERMANECE em coupons e o historico em coupon_redemptions sobrevive intacto":
 *     COUNT(coupons)==1 por cupom ao final; as linhas de redencao continuam la (>=1) e
 *     NUNCA decrescem (discount_cents/order_id da ancora intactos).
 *  A3 "audit_log NAO ganha linha de coupon.delete": 0 linhas action='coupon.delete' (coluna
 *     crua, @map DOTTED) para os cupons da feature; delta GLOBAL de audit_log nesse range
 *     == apenas os efeitos legais (redeem nao audita; deactivate audita 1x — contabilizado).
 *  A4 "Caminho correto e inativar: setCouponActive(false) deixa isActive=false (auditado
 *     como coupon.deactivate na MESMA transacao)": is_active=false, cupom ainda existe,
 *     EXATAMENTE 1 linha audit_log action='coupon.deactivate' para esse entity_id (e 0
 *     coupon.delete).
 *
 * Invariantes cobertas:
 *  - coupon-delete-guard: o delete e RECUSADO porque ha redencao. CAMADA 1 (guarda de
 *    aplicacao que conta coupon_redemptions) exercitada em runtime nas FASES A/B sob
 *    concorrencia; CAMADA 2 (FK onDelete:Restrict -> P2003) exercitada em runtime na
 *    FASE D (alem do sanity de schema confdeltype='r'). Historico financeiro intacto.
 *  - audit-same-tx: delete barrado => NENHUMA linha de audit (nem orfa); a inativacao do
 *    caminho correto grava EXATAMENTE 1 coupon.deactivate na MESMA tx.
 */

const SEAM_RUNNER = path.join(__dirname, "..", "estoque", "_run-seam.ts");

type CouponMutationResult =
  | { ok: false; error: string }
  | { ok: true; coupon: { id: string; code: string; isActive: boolean; redeemedCount: number } };

type CouponDeleteResult = { ok: true; id: string } | { ok: false; error: string };
type RedeemResult = { ok: true; alreadyRedeemed: boolean } | { ok: false; reason: string };

/** Desfecho de um processo concorrente (delete OU redeem) — sempre resolve, nunca rejeita. */
type Outcome<T> = { kind: "delete" | "redeem"; id: string; result: T | null; error: string | null };

/** Chama uma op do seam via processo tsx SINCRONO (setup serial). */
function runSeamSync<T>(op: string, payload: unknown): T {
  const r = spawnSync("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
    encoding: "utf8",
    // Herda DATABASE_URL do runner; payload via env (nao argv) p/ nao depender do
    // quoting de JSON pelo shell do Windows.
    env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
    shell: process.platform === "win32", // resolve .cmd no Windows
  });
  const out = `${r.stdout ?? ""}`;
  if (r.status !== 0 && !out.includes("__SEAM_")) {
    throw new Error(`seam runner falhou (status ${r.status}):\n${out}\n${r.stderr ?? ""}`);
  }
  const okLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
  const errLine = out.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
  if (errLine) {
    const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
    throw new Error(`${e.name}: ${e.message}`);
  }
  if (!okLine) throw new Error(`seam runner sem resultado:\n${out}\n${r.stderr ?? ""}`);
  return JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as T;
}

/**
 * Dispara uma op do seam via processo tsx ASSINCRONO. RETORNA uma Promise que so resolve
 * quando o processo termina — permitindo que N ops rodem em PARALELO REAL via Promise.all
 * (cada uma e um processo/transacao independente no MESMO Postgres). Resolve sempre (nunca
 * rejeita) com o resultado do seam OU um erro de processo, para Promise.all coletar TODOS
 * os desfechos (e um P-error vazado virar reprovacao, nao excecao engolida).
 */
function runSeamAsync<T>(
  kind: "delete" | "redeem",
  id: string,
  op: string,
  payload: unknown,
): Promise<Outcome<T>> {
  return new Promise<Outcome<T>>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", SEAM_RUNNER, op], {
      env: { ...process.env, SEAM_PAYLOAD: JSON.stringify(payload) },
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) =>
      resolve({ kind, id, result: null, error: `spawn error: ${e.message}` }),
    );
    child.on("close", (status) => {
      const okLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_RESULT__"));
      const errLine = stdout.split(/\r?\n/).find((l) => l.startsWith("__SEAM_ERROR__"));
      if (okLine) {
        resolve({
          kind,
          id,
          result: JSON.parse(okLine.slice("__SEAM_RESULT__".length)) as T,
          error: null,
        });
        return;
      }
      if (errLine) {
        const e = JSON.parse(errLine.slice("__SEAM_ERROR__".length));
        resolve({ kind, id, result: null, error: `${e.name}: ${e.message}` });
        return;
      }
      resolve({
        kind,
        id,
        result: null,
        error: `seam runner sem resultado (status ${status}):\n${stdout}\n${stderr}`,
      });
    });
  });
}

function makeClient(): Client {
  const url = process.env.DATABASE_URL;
  expect(url, "DATABASE_URL deve ser exportada pelo runner do harness").toBeTruthy();
  return new Client({ connectionString: url });
}

/**
 * Espera (poll em pg_stat_activity) ate que ALGUM backend que NAO seja o nosso esteja
 * ATIVO e BLOQUEADO em um Lock numa query que toca "coupons". Na FASE D isso prova,
 * de forma determinista, que o DELETE de deleteCoupon (processo filho) ja PASSOU a
 * guarda de aplicacao (leu COUNT=0, pois a redencao concorrente esta NAO-COMMITADA e
 * invisivel sob READ COMMITTED) e agora aguarda o lock FK-share da redencao pendente —
 * exatamente a janela TOCTOU que a rede final (FK onDelete:Restrict -> P2003) fecha.
 * Retorna true assim que detecta o bloqueio; false se estourar o timeout.
 */
async function waitForBlockedDelete(client: Client, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()
          AND query ILIKE '%coupons%'`,
    );
    if (Number(r.rows[0].n) >= 1) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

const ACTOR = { clerkUserId: null, email: null, role: null };

/** Input de cupom percent valido (semeado via createCoupon de PRODUCAO). */
function percentCoupon(code: string) {
  return {
    code,
    type: "percent" as const,
    percentOff: 15,
    valueCents: null,
    minSubtotalCents: 0,
    maxRedemptions: null,
    perUserLimit: null,
    isActive: true,
    startsAt: null,
    expiresAt: null,
  };
}

/** Cria um pedido PROPRIO minimo (INSERT direto em pg) e devolve seu id (FK p/ redeem). */
async function insertOrder(client: Client, tag: string): Promise<number> {
  const ins = await client.query<{ id: number }>(
    `INSERT INTO "orders" (
       clerk_user_id, customer_name, customer_email, customer_phone,
       address_cep, address_street, address_city, address_state,
       subtotal_cents, discount_cents, shipping_cents, total_cents,
       payment_status, payment_method, shipping_status,
       stock_reserved, stock_committed
     ) VALUES (
       $1, $2, $3, $4,
       '01001000', 'Rua Teste', 'Sao Paulo', 'SP',
       10000, 0, 0, 10000,
       'pending', 'pix', 'pending',
       false, false
     ) RETURNING id`,
    [`user-${tag}`, "Cliente Harness", `cliente-${tag}@harness.test`, "11999999999"],
  );
  return ins.rows[0].id;
}

/** Semeia um cupom percent + 1 redencao "ancora" REAL (via PRODUCAO). Devolve ids. */
async function seedCouponWithRedemption(
  client: Client,
  tag: string,
): Promise<{ couponId: string; anchorOrderId: number; anchorDiscount: number }> {
  const code = `DELG-${tag}`;
  const created = runSeamSync<CouponMutationResult>("createCoupon", {
    actor: ACTOR,
    input: percentCoupon(code),
  });
  expect(created.ok, `criacao do cupom deveria ter sucesso: ${JSON.stringify(created)}`).toBe(true);
  if (!created.ok) throw new Error("inalcancavel");
  const couponId = created.coupon.id;

  const anchorOrderId = await insertOrder(client, `${tag}-anchor`);
  const anchorDiscount = 1500;
  const redeem = runSeamSync<RedeemResult>("redeemCoupon", {
    couponId,
    orderId: anchorOrderId,
    userId: `user-${tag}-anchor`,
    discountCents: anchorDiscount,
    perUserLimit: null,
    maxRedemptions: null,
  });
  expect(redeem.ok, `redencao ancora deveria ter sucesso: ${JSON.stringify(redeem)}`).toBe(true);
  if (!redeem.ok) throw new Error("inalcancavel");
  expect(redeem.alreadyRedeemed, "redencao ancora e nova (nao repeticao)").toBe(false);
  return { couponId, anchorOrderId, anchorDiscount };
}

test("chaos.coupon.delete-guard: cupom COM historico nunca e excluido sob deletes concorrentes E sob corrida delete x redeem; caminho e inativar", async () => {
  // Muitos processos tsx concorrentes (cada um sobe um Prisma) sob Windows: folga ampla.
  test.setTimeout(300_000);

  const client = makeClient();
  await client.connect();
  try {
    // ========================================================================
    // SANITY de schema — sem isto as invariantes seriam vacuas.
    // ========================================================================
    // (a) FK coupon_redemptions.coupon_id e onDelete RESTRICT ('r'): e a rede final que,
    //     na janela de corrida (redencao entre a contagem e o delete), dispara P2003 e
    //     impede o apagamento do historico financeiro.
    const fk = await client.query<{ confdeltype: string }>(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname = 'coupon_redemptions'
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
             WHERE a.attrelid = c.conrelid
               AND a.attnum = ANY (c.conkey)
               AND a.attname = 'coupon_id'
          )`,
    );
    expect(fk.rowCount, "FK em coupon_redemptions.coupon_id deve existir").toBeGreaterThanOrEqual(
      1,
    );
    expect(
      fk.rows.some((r) => r.confdeltype === "r"),
      "FK coupon_redemptions.coupon_id deve ser onDelete RESTRICT ('r') — rede final anti-corrida",
    ).toBe(true);

    const runTag = randomUUID().slice(0, 8);

    // ========================================================================
    // FASE A — N deletes SIMULTANEOS sobre um cupom que JA tem 1 redencao real.
    //   Todos devem ser barrados (in_use); o cupom e o historico sobrevivem.
    // ========================================================================
    const N_DELETE = 12; // >=10 deletes concorrentes do MESMO cupom
    const aTag = `${runTag}-A`;
    const a = await seedCouponWithRedemption(client, aTag);

    // pre-condicao anti-trivial: o cupom EXISTE e tem EXATAMENTE 1 redencao real (ramo in_use).
    const preA = await client.query<{ ccount: string; rcount: string }>(
      `SELECT (SELECT COUNT(*) FROM "coupons" WHERE id=$1)::text AS ccount,
              (SELECT COUNT(*) FROM "coupon_redemptions" WHERE coupon_id=$1)::text AS rcount`,
      [a.couponId],
    );
    expect(Number(preA.rows[0].ccount), "FASE A pre: cupom existe").toBe(1);
    expect(Number(preA.rows[0].rcount), "FASE A pre: 1 redencao real (ramo COM uso)").toBe(1);

    // baseline de audit GLOBAL (provaremos delta 0 nos deletes barrados desta fase).
    const baseAuditA = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const A0 = Number(baseAuditA.rows[0].count);

    // ACAO: N deletes em PARALELO REAL (Promise.all sobre spawn assincrono; NAO spawnSync).
    const deleteOutcomes = await Promise.all(
      Array.from({ length: N_DELETE }, (_, i) =>
        runSeamAsync<CouponDeleteResult>("delete", `del-${i}`, "deleteCoupon", {
          actor: ACTOR,
          id: a.couponId,
        }),
      ),
    );

    // === A1 (fase A): nenhum P-error vazado; TODOS ok:false in_use; nenhum ok:true. ======
    const delProcFailures = deleteOutcomes.filter((o) => o.result === null);
    expect(
      delProcFailures,
      `nenhum delete pode vazar erro de processo/Prisma:\n${JSON.stringify(delProcFailures, null, 2)}`,
    ).toHaveLength(0);
    const delWinners = deleteOutcomes.filter((o) => o.result?.ok === true);
    expect(delWinners.length, "FASE A: NENHUM delete pode ter sucesso (cupom tem historico)").toBe(
      0,
    );
    for (const o of deleteOutcomes) {
      expect(o.result, `delete deve ter resultado (racer ${o.id})`).not.toBeNull();
      if (!o.result || o.result.ok) throw new Error("inalcancavel");
      expect(
        o.result.error.startsWith("Cupom já foi utilizado"),
        `delete deve ser in_use, veio: ${o.result.error} (racer ${o.id})`,
      ).toBe(true);
    }

    // === A2 (fase A): cupom PERMANECE; historico intacto. ================================
    const afterA = await client.query<{
      ccount: string;
      is_active: boolean;
      rcount: string;
      max_discount: number;
    }>(
      `SELECT (SELECT COUNT(*) FROM "coupons" WHERE id=$1)::text AS ccount,
              (SELECT BOOL_AND(is_active) FROM "coupons" WHERE id=$1) AS is_active,
              (SELECT COUNT(*) FROM "coupon_redemptions" WHERE coupon_id=$1)::text AS rcount,
              (SELECT MAX(discount_cents) FROM "coupon_redemptions" WHERE coupon_id=$1) AS max_discount`,
      [a.couponId],
    );
    expect(Number(afterA.rows[0].ccount), "FASE A: cupom PERMANECE (delete barrado)").toBe(1);
    expect(afterA.rows[0].is_active, "FASE A: registro inalterado (segue ativo)").toBe(true);
    expect(Number(afterA.rows[0].rcount), "FASE A: historico intacto (1 redencao)").toBe(1);
    expect(afterA.rows[0].max_discount, "FASE A: discount_cents da ancora intacto").toBe(
      a.anchorDiscount,
    );

    // === A3 (fase A): delete barrado NAO grava audit (delta GLOBAL 0; 0 coupon.delete). ==
    const auditAfterA = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(Number(auditAfterA.rows[0].count), "FASE A: nenhum audit gravado (delta global 0)").toBe(
      A0,
    );
    const delAuditA = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE action='coupon.delete' AND entity_id=$1`,
      [a.couponId],
    );
    expect(
      Number(delAuditA.rows[0].count),
      "FASE A: 0 linhas coupon.delete (delete nunca procedeu)",
    ).toBe(0);

    // ========================================================================
    // FASE B — A CORRIDA do enunciado: para K cupons, dispara EM PARALELO REAL
    //   1 deleteCoupon + 1 redeemCoupon NOVO (outro pedido) do MESMO cupom.
    //   Qualquer interleaving e seguro (guard de aplicacao OU FK Restrict/P2003);
    //   o cupom NUNCA e apagado e o historico so cresce.
    // ========================================================================
    const K = 8; // cupons em corrida (cada um: 1 delete x 1 redeem concorrentes)
    const seeds: {
      couponId: string;
      anchorOrderId: number;
      anchorDiscount: number;
      raceOrderId: number;
      tag: string;
    }[] = [];
    for (let i = 0; i < K; i++) {
      const tag = `${runTag}-B${i}`;
      const seed = await seedCouponWithRedemption(client, tag);
      const raceOrderId = await insertOrder(client, `${tag}-race`); // pedido NOVO p/ o redeem concorrente
      seeds.push({ ...seed, raceOrderId, tag });
    }

    // baseline de audit p/ provar (delta global == apenas efeitos legais nesta fase).
    const baseAuditB = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const B0 = Number(baseAuditB.rows[0].count);

    // ACAO: para CADA cupom, 1 delete + 1 redeem CONCORRENTES; todos os 2K processos no
    // mesmo Promise.all => corrida real e entrelacada entre cupons e entre delete/redeem.
    const raceJobs: Promise<Outcome<CouponDeleteResult | RedeemResult>>[] = [];
    for (const s of seeds) {
      raceJobs.push(
        runSeamAsync<CouponDeleteResult>("delete", s.couponId, "deleteCoupon", {
          actor: ACTOR,
          id: s.couponId,
        }),
      );
      raceJobs.push(
        runSeamAsync<RedeemResult>("redeem", s.couponId, "redeemCoupon", {
          couponId: s.couponId,
          orderId: s.raceOrderId,
          userId: `user-${s.tag}-race`,
          discountCents: 2200,
          perUserLimit: null,
          maxRedemptions: null,
        }),
      );
    }
    const raceOutcomes = await Promise.all(raceJobs);

    // === A1 (fase B): nenhum P-error vazado; CADA delete e ok:false in_use; o redeem
    //     concorrente OU sucesso (commitou antes/depois do delete) — ambos seguros. =======
    const raceProcFailures = raceOutcomes.filter((o) => o.result === null);
    expect(
      raceProcFailures,
      `corrida: nenhum processo pode vazar erro (P2003 deve virar in_use):\n${JSON.stringify(
        raceProcFailures,
        null,
        2,
      )}`,
    ).toHaveLength(0);

    const raceDeletes = raceOutcomes.filter(
      (o) => o.kind === "delete",
    ) as Outcome<CouponDeleteResult>[];
    const raceRedeems = raceOutcomes.filter((o) => o.kind === "redeem") as Outcome<RedeemResult>[];
    expect(raceDeletes.length, "corrida: K deletes").toBe(K);
    expect(raceRedeems.length, "corrida: K redeems").toBe(K);

    for (const o of raceDeletes) {
      expect(o.result, `corrida: delete deve ter resultado (cupom ${o.id})`).not.toBeNull();
      if (!o.result) throw new Error("inalcancavel");
      expect(
        o.result.ok,
        `corrida: delete NUNCA pode apagar cupom com historico (cupom ${o.id}): ${JSON.stringify(o.result)}`,
      ).toBe(false);
      if (o.result.ok) throw new Error("inalcancavel");
      expect(
        o.result.error.startsWith("Cupom já foi utilizado"),
        `corrida: delete barrado deve ser in_use (cupom ${o.id}), veio: ${o.result.error}`,
      ).toBe(true);
    }
    // O redeem concorrente nunca pode vazar erro de processo; ele e ou ok:true (nova linha)
    // ou ok:true/alreadyRedeemed (improvavel aqui, pedido novo) — nunca um P-error.
    for (const o of raceRedeems) {
      expect(o.result, `corrida: redeem deve ter resultado (cupom ${o.id})`).not.toBeNull();
    }

    // === A2 (fase B): para CADA cupom — PERMANECE em coupons; historico NUNCA decresce
    //     (a ancora sobrevive; se o redeem concorrente venceu, ha 2 linhas, senao 1). =====
    for (const s of seeds) {
      const row = await client.query<{ ccount: string; rcount: string; anchor: string }>(
        `SELECT (SELECT COUNT(*) FROM "coupons" WHERE id=$1)::text AS ccount,
                (SELECT COUNT(*) FROM "coupon_redemptions" WHERE coupon_id=$1)::text AS rcount,
                (SELECT COUNT(*) FROM "coupon_redemptions" WHERE order_id=$2)::text AS anchor`,
        [s.couponId, s.anchorOrderId],
      );
      expect(
        Number(row.rows[0].ccount),
        `corrida: cupom ${s.couponId} PERMANECE (nunca apagado)`,
      ).toBe(1);
      expect(
        Number(row.rows[0].rcount),
        `corrida: historico de ${s.couponId} so cresce (>=1, a ancora sempre sobrevive)`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        Number(row.rows[0].anchor),
        `corrida: a redencao ANCORA de ${s.couponId} sobrevive intacta`,
      ).toBe(1);
    }

    // === A3 (fase B): 0 linhas coupon.delete p/ qualquer cupom da corrida; o delta global
    //     de audit desta fase vem APENAS dos efeitos legais (redeem nao audita). ==========
    const couponIds = seeds.map((s) => s.couponId);
    // entity_id e TEXT (acomoda uuid de cupom/produto E int de pedido — schema.prisma L199-200),
    // entao a comparacao em lote tem de ser text[], nao uuid[] (senao 'operator does not exist:
    // text = uuid'). Os couponIds sao uuids serializados como string, que casam com o TEXT gravado.
    const delAuditB = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE action='coupon.delete' AND entity_id = ANY($1::text[])`,
      [couponIds],
    );
    expect(
      Number(delAuditB.rows[0].count),
      "corrida: 0 audit coupon.delete (nenhum delete procedeu)",
    ).toBe(0);
    const auditAfterB = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfterB.rows[0].count),
      "corrida: delta de audit == 0 (redeem nao audita; nenhum delete audita)",
    ).toBe(B0);

    // ========================================================================
    // FASE C (A4) — CAMINHO CORRETO: inativar (setCouponActive false), nao excluir.
    //   Usamos o cupom da FASE A; deactivate audita coupon.deactivate na MESMA tx.
    // ========================================================================
    const preDeactivateAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE action='coupon.deactivate' AND entity_id=$1`,
      [a.couponId],
    );
    expect(
      Number(preDeactivateAudit.rows[0].count),
      "FASE C pre: 0 audit coupon.deactivate ainda",
    ).toBe(0);

    const deactivated = runSeamSync<CouponMutationResult>("setCouponActive", {
      actor: ACTOR,
      id: a.couponId,
      isActive: false,
    });
    expect(
      deactivated.ok,
      `inativar (caminho correto) deve ter sucesso: ${JSON.stringify(deactivated)}`,
    ).toBe(true);
    if (!deactivated.ok) throw new Error("inalcancavel");

    const afterDeactivate = await client.query<{
      count: string;
      is_active: boolean;
      rcount: string;
    }>(
      `SELECT (SELECT COUNT(*) FROM "coupons" WHERE id=$1)::text AS count,
              (SELECT BOOL_AND(is_active) FROM "coupons" WHERE id=$1) AS is_active,
              (SELECT COUNT(*) FROM "coupon_redemptions" WHERE coupon_id=$1)::text AS rcount`,
      [a.couponId],
    );
    expect(Number(afterDeactivate.rows[0].count), "FASE C: inativar NAO apaga (cupom existe)").toBe(
      1,
    );
    expect(
      afterDeactivate.rows[0].is_active,
      "FASE C: is_active=false (saiu de circulacao sem ser excluido)",
    ).toBe(false);
    expect(
      Number(afterDeactivate.rows[0].rcount),
      "FASE C: historico preservado apos inativacao",
    ).toBe(1);

    // === A4 / audit-same-tx: EXATAMENTE 1 coupon.deactivate p/ esse cupom; 0 coupon.delete. =
    const deactivateAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE action='coupon.deactivate' AND entity_id=$1`,
      [a.couponId],
    );
    expect(
      Number(deactivateAudit.rows[0].count),
      "FASE C: 1 linha coupon.deactivate (inativacao auditada na mesma tx)",
    ).toBe(1);
    const stillNoDeleteAudit = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE action='coupon.delete' AND entity_id=$1`,
      [a.couponId],
    );
    expect(
      Number(stillNoDeleteAudit.rows[0].count),
      "FASE C: jamais houve coupon.delete p/ esse cupom",
    ).toBe(0);

    // ========================================================================
    // FASE D — A REDE FINAL (FK Restrict -> P2003 -> in_use), exercitada de forma
    //   DETERMINISTA. FASE A/B provam a GUARDA DE APLICACAO (COUNT>=1 ja barra antes
    //   do DELETE), mas NUNCA atingem o catch de P2003 (L282-286 de coupons.ts) — la
    //   o delete nem chega ao tx.coupon.delete(). Aqui forcamos a JANELA TOCTOU exata:
    //   uma conexao (connB) segura uma redencao NAO-COMMITADA (lock FK-share na linha
    //   do cupom). deleteCoupon (processo filho) le COUNT=0 (connB invisivel sob READ
    //   COMMITTED), PASSA a guarda e tenta o DELETE — que BLOQUEIA no lock de connB.
    //   Quando detectamos o bloqueio, commitamos connB: a linha filha vira visivel, o
    //   DELETE re-checa a RI RESTRICT e dispara P2003, que deleteCoupon TRADUZ em
    //   in_use. Se o catch de P2003 fosse removido do produto, o erro VAZARIA como
    //   __SEAM_ERROR__ (result:null) e esta fase reprovaria — prova anti-fake-green
    //   DESTE caminho, que a guarda de aplicacao das fases A/B nao cobre.
    // ========================================================================
    const dTag = `${runTag}-D`;
    const dCode = `DELG-${dTag}`;
    const dCreated = runSeamSync<CouponMutationResult>("createCoupon", {
      actor: ACTOR,
      input: percentCoupon(dCode),
    });
    expect(
      dCreated.ok,
      `FASE D: criacao do cupom deveria ter sucesso: ${JSON.stringify(dCreated)}`,
    ).toBe(true);
    if (!dCreated.ok) throw new Error("inalcancavel");
    const dCouponId = dCreated.coupon.id;
    const dOrderId = await insertOrder(client, `${dTag}-pending`);

    // pre-condicao anti-trivial: o cupom existe e tem COUNT=0 (ramo que ALCANCA o DELETE).
    const preD = await client.query<{ ccount: string; rcount: string }>(
      `SELECT (SELECT COUNT(*) FROM "coupons" WHERE id=$1)::text AS ccount,
              (SELECT COUNT(*) FROM "coupon_redemptions" WHERE coupon_id=$1)::text AS rcount`,
      [dCouponId],
    );
    expect(Number(preD.rows[0].ccount), "FASE D pre: cupom existe").toBe(1);
    expect(
      Number(preD.rows[0].rcount),
      "FASE D pre: COUNT=0 (deleteCoupon vai PASSAR a guarda)",
    ).toBe(0);

    const baseAuditD = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    const D0 = Number(baseAuditD.rows[0].count);

    // connB: segura uma redencao NAO-COMMITADA (lock FK-share na linha do cupom).
    const connB = makeClient();
    await connB.connect();
    let dOutcome: Outcome<CouponDeleteResult>;
    try {
      await connB.query("BEGIN");
      await connB.query(
        `INSERT INTO "coupon_redemptions" (id, coupon_id, order_id, clerk_user_id, discount_cents, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, now())`,
        [randomUUID(), dCouponId, dOrderId, `user-${dTag}-race`, 1300],
      );

      // Dispara deleteCoupon: COUNT=0 (connB invisivel) -> passa a guarda -> DELETE BLOQUEIA.
      // POR QUE o timeout default de 5s do prisma.$transaction de deleteCoupon NAO vira
      // P2028 aqui: (1) as fases A/B/C ja foram TOTALMENTE aguardadas — nenhum processo
      // tsx concorrente disputa o banco durante a FASE D; (2) findUnique e count NAO
      // bloqueiam (SELECT simples nao conflita com o lock FK-share de connB; e o COUNT
      // sob READ COMMITTED ignora a linha NAO-COMMITADA de connB), logo a transacao
      // ALCANCA o DELETE em ~ms apos abrir; (3) so o DELETE bloqueia, e o detectamos no
      // proximo poll (<=50ms) e commitamos connB IMEDIATAMENTE — a tx de A fica aberta
      // por ~ms, muito abaixo dos 5s. O boot do tsx (~2-3s) e ANTES do BEGIN, fora do timer.
      const dDeletePromise = runSeamAsync<CouponDeleteResult>("delete", dCouponId, "deleteCoupon", {
        actor: ACTOR,
        id: dCouponId,
      });

      // Espera o DELETE bloquear (prova que a guarda foi passada e a rede FK e quem decide).
      const blocked = await waitForBlockedDelete(client, 30_000);
      expect(
        blocked,
        "FASE D: o DELETE de deleteCoupon deve BLOQUEAR no lock da redencao pendente (prova que leu COUNT=0, passou a guarda e atingiu a rede FK — NAO o ramo da guarda de aplicacao)",
      ).toBe(true);

      // Commit da redencao: a linha vira visivel -> o DELETE re-checa RI RESTRICT -> P2003.
      await connB.query("COMMIT");

      dOutcome = await dDeletePromise;
    } finally {
      await connB.end();
    }

    // === A1 (fase D): P2003 NAO pode vazar; deleteCoupon traduz em ok:false in_use. =====
    expect(
      dOutcome.result,
      `FASE D: deleteCoupon NAO pode vazar P-error — o P2003 da FK Restrict deve ser TRADUZIDO em in_use (erro de processo indica catch removido): ${JSON.stringify(
        dOutcome,
      )}`,
    ).not.toBeNull();
    if (!dOutcome.result) throw new Error("inalcancavel");
    expect(
      dOutcome.result.ok,
      "FASE D: delete sob corrida P2003 deve ser BARRADO (nunca apaga)",
    ).toBe(false);
    if (dOutcome.result.ok) throw new Error("inalcancavel");
    expect(
      dOutcome.result.error.startsWith("Cupom já foi utilizado"),
      `FASE D: P2003 deve virar in_use, veio: ${dOutcome.result.error}`,
    ).toBe(true);

    // === A2 (fase D): cupom PERMANECE; a redencao que disparou a corrida sobrevive. =====
    const afterD = await client.query<{ ccount: string; rcount: string }>(
      `SELECT (SELECT COUNT(*) FROM "coupons" WHERE id=$1)::text AS ccount,
              (SELECT COUNT(*) FROM "coupon_redemptions" WHERE coupon_id=$1)::text AS rcount`,
      [dCouponId],
    );
    expect(
      Number(afterD.rows[0].ccount),
      "FASE D: cupom PERMANECE (DELETE rejeitado pela FK)",
    ).toBe(1);
    expect(
      Number(afterD.rows[0].rcount),
      "FASE D: a redencao (agora commitada) sobrevive — historico intacto",
    ).toBe(1);

    // === A3 (fase D): o DELETE rejeitado nao audita (delta global 0; 0 coupon.delete). ==
    const auditAfterD = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log"`,
    );
    expect(
      Number(auditAfterD.rows[0].count),
      "FASE D: nenhum audit gravado (DELETE abortado pela FK; delta global 0)",
    ).toBe(D0);
    const delAuditD = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "audit_log" WHERE action='coupon.delete' AND entity_id=$1`,
      [dCouponId],
    );
    expect(
      Number(delAuditD.rows[0].count),
      "FASE D: 0 coupon.delete (o delete nunca commitou)",
    ).toBe(0);
  } finally {
    await client.end();
  }
});

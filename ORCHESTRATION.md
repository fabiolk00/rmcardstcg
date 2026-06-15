# RM Cards — Verificacao multiagente (billing, N+1, estoque, usuarios)

Setup de auditoria com Claude Code agent teams + quality gate automatico.
O loop plan -> fix -> QA -> fix -> QA -> fix nao e orquestrado na mao: ele cai
de tres mecanismos da doc oficial.

## Como o loop e enforced

1. Plan (gate de entrada): cada auditor sobe em `permissionMode: plan` (read-only).
   Ele planeja, manda o plano pro lead, e so implementa depois da aprovacao.
   No spawn, peca "require plan approval".
2. Fix: aprovado o plano, o auditor edita SO o file-set dele.
3. QA (gate de saida, automatico): ao marcar a task como concluida, o hook
   `TaskCompleted` roda `scripts/qa-gate.sh`. Se reprovar, sai com exit 2,
   bloqueia a conclusao e devolve o feedback -> o auditor faz outro fix.
   Isso gera fix -> QA -> fix -> QA sozinho, ate o gate passar.
4. QA semantico: o teammate `qa-gate` revisa o que o script nao pega
   (causa vs sintoma, regressao de contrato, reproducao da corrida).

Cap de rounds: defina no prompt ("no maximo 3 rounds de fix por task; se ainda
reprovar, reporte como achado aberto"). Sem cap, o gate pode iterar demais.

## Restricoes da doc que moldam o desenho

- Um lead gerencia UM time por vez; nao ha times aninhados.
  Logo NAO da pra ter 4 times paralelos com sub-loop cada. Use 1 time com
  4 auditores + 1 QA, OU rode 4 vezes (1 dominio por execucao).
- Agent teams custam ~varios x os tokens de uma sessao unica. Rode lead e
  planejamento no Opus (claude-opus-4-8) e o QA/varredura no Sonnet/Haiku.
- Evite conflito de arquivo: dois teammates editando o mesmo arquivo se
  sobrescrevem. Veja a secao de file-sets abaixo.

## File-sets e o arquivo compartilhado (orders)

billing -> app/api/webhooks/asaas, app/api/internal/reconcile-orders, lib/services/asaas, orderTransitions
stock -> lib/data/inventory, reserva/commit/estorno
users -> webhooks/clerk, lib/auth, middleware, cupom/checkout/totais
nplusone -> caminhos de leitura em lib/data/\* e telas (so otimiza leitura)

`lib/data/orders.ts` e tocado por billing, stock e users. Para nao colidir:
defina orders.ts como propriedade do STOCK (ele mexe na reserva/commit, o nucleo).
billing e users propoem os diffs de orders.ts via QA/lead; o stock aplica.
Alternativa: serializar — billing roda, depois stock, depois users — com
dependencia de task entre eles. O lead resolve isso com a task list compartilhada.

## Pre-requisitos no repo

1. Copie `.claude/` e `scripts/` para a raiz do projeto.
2. `chmod +x scripts/qa-gate.sh`
3. package.json: adicione
   "test:nplusone": "vitest run tests/nplusone"
   (instale vitest se ainda nao tiver: `pnpm add -D vitest`)
4. Crie tests/nplusone/ com pelo menos um teste por caminho quente usando
   scripts/count-queries.ts (o auditor de N+1 gera o resto).
5. Garanta DATABASE_URL de teste apontando pra um Postgres descartavel
   (Supabase branch ou container), porque os testes de N+1 e de corrida batem no banco real.
6. Confirme a versao: `claude --version` >= 2.1.32 (agent teams) e idealmente >= 2.1.172 (subagents aninhados).

## Master prompt (cole no lead, com agent teams habilitado)

> Crie um agent team para auditar o RM Cards. Spawne 4 auditores usando as
> definicoes de subagent: audit-billing, audit-stock, audit-users, audit-nplusone;
> e 1 QA usando qa-gate. Exija aprovacao de plano para os 4 auditores antes de
> qualquer edicao. Regras de aprovacao: so aprove planos que (a) ataquem a causa
> no nivel de transacao/CAS, nao sintoma, e (b) incluam um teste de prova
> (corrida com 2 atores, ou contagem de N+1 <= 15).
>
> Ownership de arquivos: orders.ts pertence ao audit-stock; billing e users
> propoem diffs de orders.ts via voce, o stock aplica. Nenhum auditor edita fora
> do seu file-set sem te avisar.
>
> Loop por task: plano (aprovado) -> fix -> o hook TaskCompleted roda o gate ->
> se reprovar, o auditor refaz o fix. Maximo 3 rounds de fix por task; se ainda
> reprovar no 3o, registre como achado aberto com repro e siga. O qa-gate revisa
> cada fix tentando derruba-lo antes de aprovar.
>
> Espere os teammates terminarem antes de sintetizar. No fim, produza um relatorio
> por dominio: achados (severidade), fixes aplicados com arquivo:linha, testes
> adicionados, e achados abertos. Depois limpe o time.

## Variante mais barata (sem agent teams)

Se quiser gastar menos tokens e nao precisar do QA "desafiando" em paralelo:
rode numa sessao unica e delegue cada dominio a um subagent (mesmas definicoes em
.claude/agents). Os subagents podem rodar pesquisa em paralelo e, na v2.1.172+,
o auditor pode spawnar um verificador aninhado por achado. O gate continua valendo
pelo hook. Menos coordenacao lateral, custo bem menor.

## Ordem sugerida de execucao (se for sequencial)

1. stock (nucleo do inventario e do orders.ts)
2. billing (depende do estado de orders/commit)
3. users (cupom/checkout, depende de orders)
4. nplusone (otimiza leitura por ultimo, depois que o shape estabilizou)

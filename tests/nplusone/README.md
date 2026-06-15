# Testes de N+1

Provam que os caminhos de leitura quentes não passam de **15 round-trips** ao
Postgres (`N_PLUS_ONE_THRESHOLD` em `scripts/count-queries.ts`). A contagem é
feita no nível do `pg.Pool` (não no Prisma): é o número de idas ao banco que
explode num loop.

## Pré-requisito: um Postgres descartável

Os testes batem em um banco real e são **opt-in** via `TEST_DATABASE_URL`. Sem
essa variável a suíte é **pulada** (`describe.skipIf`), então `pnpm test:nplusone`
e o `qa-gate.sh` continuam verdes em ambientes sem banco.

> Por que não `DATABASE_URL`? O CI define `DATABASE_URL` com um valor _dummy_
> inalcançável só para o build mock-first passar. Se a suíte usasse `DATABASE_URL`,
> tentaria conectar nesse dummy e falharia no CI. Por isso ela exige uma variável
> dedicada e alcançável: `TEST_DATABASE_URL`.

Para rodar de verdade:

```bash
# 1. suba um Postgres descartável
docker run --rm -e POSTGRES_PASSWORD=test -p 5432:5432 -d postgres

# 2. migre o schema (prisma usa DATABASE_URL/DIRECT_URL)
export DATABASE_URL="postgresql://postgres:test@localhost:5432/postgres"
export DIRECT_URL="$DATABASE_URL"
pnpm prisma migrate deploy
pnpm db:seed            # popula catálogo (opcional, mas dá dados para medir)

# 3. rode os testes apontando TEST_DATABASE_URL para o mesmo banco
export TEST_DATABASE_URL="$DATABASE_URL"
pnpm test:nplusone
```

> Use de preferência a connection string do **pooler** (porta 6543, pgbouncer
> transaction-mode) ao validar produção — é o caminho real e o que estressa o
> limite de conexões.

## Como medir um novo caminho

```ts
import { makeCountingPool } from "../../scripts/count-queries";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../lib/generated/prisma/client";

const counting = makeCountingPool(process.env.DATABASE_URL!);
const db = new PrismaClient({ adapter: new PrismaPg(counting.pool) });
const { queries } = await counting.measure(() => /* função de dados do caminho */);
expect(queries).toBeLessThanOrEqual(15);
```

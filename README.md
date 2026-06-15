# RM Cards

E-commerce de cartas colecionáveis (TCG) — loja virtual + painel administrativo,
com pagamento via **PIX (Asaas)**, autenticação **Clerk**, e-mails transacionais
**Resend** e banco **Postgres (Supabase)** acessado por **Prisma 7**.

Construído sobre **Next.js 15 (App Router) + React 19** em TypeScript.

---

## Índice

- [Intuito](#intuito)
- [Funcionalidades](#funcionalidades)
- [Stack](#stack)
- [Princípios de arquitetura](#princípios-de-arquitetura)
- [Estrutura de pastas](#estrutura-de-pastas)
- [Modelo de dados (schemas das tabelas)](#modelo-de-dados-schemas-das-tabelas)
- [Fluxos principais](#fluxos-principais)
- [Jobs de pg_cron](#jobs-de-pg_cron)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Como rodar localmente](#como-rodar-localmente)
- [Scripts](#scripts)
- [Banco e migrations](#banco-e-migrations)
- [CI](#ci)

---

## Intuito

Loja online completa para venda de produtos de TCG (booster boxes, ETBs, tins,
cartas avulsas, acessórios). O sistema cobre o ciclo de ponta a ponta:

- **Vitrine pública** — catálogo, busca/filtros por categoria, página de produto,
  carrinho, cupons e checkout com geração de cobrança PIX.
- **Pós-venda** — área "Minhas compras" do cliente e e-mail de confirmação de
  pagamento.
- **Administração** — gestão de produtos, pedidos (status de pagamento e envio,
  notas internas) e cupons, com **trilha de auditoria imutável** de toda mutação.
- **Automação de back-office** — expiração de PIX vencido com estorno de estoque,
  desativação de cupons expirados, reconciliação de pagamentos e retenção de
  eventos, tudo via **pg_cron**.

Um princípio norteia o projeto: **mock-first**. Sem nenhum segredo configurado, a
aplicação roda, builda e passa no CI — as integrações externas (Clerk, Asaas,
Resend) só "ligam" quando há credenciais reais no ambiente. Isso mantém o
desenvolvimento e a CI independentes de serviços externos.

---

## Funcionalidades

### Vitrine (storefront)

| Rota                      | Descrição                                                  |
| ------------------------- | ---------------------------------------------------------- |
| `/`                       | Home com produtos em destaque                              |
| `/colecoes`               | Catálogo com filtro por categoria e paginação              |
| `/produto/[slug]`         | Página de produto com adicionar ao carrinho                |
| `/carrinho`               | Carrinho, aplicação de cupom e início do checkout          |
| `/checkout`               | Dados de entrega e geração do PIX (copia-e-cola + QR Code) |
| `/minhas-compras`         | Histórico de pedidos do cliente logado                     |
| `/entrar`, `/criar-conta` | Login e cadastro (Clerk)                                   |

### Admin (`/admin`, protegido por role)

| Rota              | Descrição                                                              |
| ----------------- | ---------------------------------------------------------------------- |
| `/admin/produtos` | CRUD de produtos, inativar/reativar, ajuste de estoque                 |
| `/admin/pedidos`  | Lista de pedidos, transição de status de envio/pagamento, nota interna |
| `/admin/cupons`   | CRUD de cupons (percentual/fixo, limites, validade)                    |

---

## Stack

| Camada      | Tecnologia                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------ |
| Framework   | Next.js 15 (App Router, Server Actions, Route Handlers)                                    |
| UI          | React 19, CSS Modules                                                                      |
| Linguagem   | TypeScript 5.7                                                                             |
| ORM / DB    | Prisma 7 (`prisma-client` generator) + driver adapter `@prisma/adapter-pg` (node-postgres) |
| Banco       | PostgreSQL (Supabase)                                                                      |
| Auth        | Clerk (`@clerk/nextjs`)                                                                    |
| Pagamento   | Asaas (PIX) — sandbox no MVP                                                               |
| E-mail      | Resend (`@react-email/components`)                                                         |
| Webhooks    | Verificação `svix` (Clerk) e token de header (Asaas)                                       |
| Agendamento | `pg_cron` + `pg_net` (no banco)                                                            |
| Gerenciador | pnpm 10                                                                                    |

---

## Princípios de arquitetura

- **Mock-first** — cada integração tem um `isXConfigured()`. Sem chave real, o
  recurso vira no-op seguro (checkout cria o pedido mas não gera PIX, e-mails não
  saem, rotas protegidas ficam abertas). Liga sozinho com a credencial real.
- **Dinheiro sempre em centavos** — inteiros com sufixo `*Cents`, nunca `float`.
  A conversão para reais acontece só na fronteira com o Asaas.
- **Preço final é derivado** — `finalPriceCents = base × (1 − desconto/100)`,
  calculado por função pura (`lib/data/pricing.ts`) e **nunca persistido**.
- **Domínio em camelCase, banco em snake_case** — o Prisma mapeia via `@map`; a
  camada `lib/data/*` traduz linhas do Postgres para os contratos de
  `lib/data/types.ts` sem vazar shape do banco para as telas.
- **Idempotência em toda escrita externa** — webhooks usam ledger
  `(provider, event_id)` + anti-replay por `asaas_payment_id` + compare-and-swap,
  tudo na **mesma transação** do efeito.
- **Ciclo de reserva de estoque** — `reservado` no checkout → `baixado`
  (committed) ao confirmar pagamento → `estornado` no cancelamento/expiração.
  Idempotente pelas flags `stock_reserved` / `stock_committed`.
- **Trilha de auditoria imutável** — toda mutação de admin grava em `audit_log`
  na mesma transação (`writeAuditLog(tx, …)`).
- **Máquinas de estado no servidor** — transições de envio e de pagamento são a
  fonte de verdade (`lib/data/orderTransitions.ts`), client-safe para a UI.
- **Funções puras client-safe** — preço, totais e desconto de cupom não importam
  `prisma`, evitando arrastar o driver para o bundle do navegador.

---

## Estrutura de pastas

```
app/
  (storefront)/            # vitrine pública (home, coleções, produto, carrinho, checkout, minhas-compras)
  admin/                   # painel admin (produtos, pedidos, cupons) — Server Actions em actions.ts
  api/
    webhooks/asaas/        # webhook de pagamento (token de header + idempotência)
    webhooks/clerk/        # webhook de usuário (assinatura svix → sincroniza users)
    internal/reconcile-orders/  # rota interna chamada pelo pg_cron (reconciliação)
  entrar/, criar-conta/    # páginas de auth do Clerk
components/
  admin/ cart/ checkout/ layout/ product/ ui/   # componentes de UI
emails/
  OrderEmail.tsx           # template React Email
lib/
  auth/                    # requireAdmin (guard de role)
  cart/                    # totals.ts (frete/subtotal), coupon.ts (desconto puro)
  data/                    # camada de dados (orders, products, coupons, users, audit, inventory, ...)
  services/
    asaas/                 # client, config, payments (PIX)
    clerk/                 # config, roles, appearance
    resend/                # envio de e-mail
  utils/                   # currency, helpers
  generated/prisma/        # Prisma Client gerado (gitignored)
prisma/
  schema.prisma            # modelos e enums
  migrations/              # SQL versionado (init → hardening → pgcron)
  seed.ts, seed-data.ts    # catálogo inicial
middleware.ts              # proteção de rotas via Clerk (no-op se não configurado)
```

---

## Modelo de dados (schemas das tabelas)

Postgres via Prisma. Colunas em `snake_case`, dinheiro em `Int` de centavos,
timestamps em `timestamptz(6)`. Definição em `prisma/schema.prisma`.

### Enums

| Enum              | Valores                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Role`            | `cliente`, `admin`                                                                                                                                               |
| `PaymentStatus`   | `pending`, `paid`, `cancelled`                                                                                                                                   |
| `ShippingStatus`  | `pending`, `sent`, `delivered`, `cancelled`                                                                                                                      |
| `CouponType`      | `percent`, `fixed`                                                                                                                                               |
| `AuditEntityType` | `product`, `order`, `coupon`, `user`                                                                                                                             |
| `AuditAction`     | `product.create/update/inactivate/reactivate/delete`, `order.payment_status_update/shipping_status_update/note_update`, `coupon.create/update/deactivate/delete` |

### `users` — espelho local do usuário Clerk

A autorização (role) vive aqui porque o auth é Clerk, não Supabase Auth.
Sincronizado pelo webhook do Clerk.

| Coluna                      | Tipo            | Notas                  |
| --------------------------- | --------------- | ---------------------- |
| `id`                        | uuid PK         |                        |
| `clerk_user_id`             | text **unique** | id do usuário no Clerk |
| `email`                     | text            |                        |
| `name`                      | text?           |                        |
| `role`                      | `Role`          | default `cliente`      |
| `created_at` / `updated_at` | timestamptz     |                        |

### `products`

| Coluna         | Tipo            | Notas                                                                                  |
| -------------- | --------------- | -------------------------------------------------------------------------------------- |
| `id`           | uuid PK         | (no mock eram `p-001`)                                                                 |
| `slug`         | text **unique** | usado em URL                                                                           |
| `name`         | text            |                                                                                        |
| `category`     | text            | String (não enum) p/ preservar acentos/espaços; validado no app                        |
| `sku`          | text **unique** |                                                                                        |
| `price_cents`  | int             | preço base                                                                             |
| `discount_pct` | int             | default 0                                                                              |
| `rating`       | decimal(2,1)    | default 0                                                                              |
| `review_count` | int             | default 0                                                                              |
| `stock`        | int             | default 0                                                                              |
| `reserved`     | int             | unidades reservadas; **CHECK `0 ≤ reserved ≤ stock`**; disponível = `stock − reserved` |
| `is_active`    | bool            | default true                                                                           |
| `badge`        | text?           | ex.: "Mais vendido"                                                                    |
| `image_url`    | text            |                                                                                        |
| `description`  | text            |                                                                                        |
| `created_at`   | timestamptz     |                                                                                        |

Índices: `category`, `is_active`.

### `orders`

| Coluna                               | Tipo                 | Notas                                          |
| ------------------------------------ | -------------------- | ---------------------------------------------- |
| `id`                                 | int PK autoincrement | domínio expõe como `#id` (ex.: `#10421`)       |
| `clerk_user_id` (`userId`)           | text                 | referência ao usuário Clerk                    |
| `customer_name/email/phone`          | text                 |                                                |
| `address_cep/street/city/state`      | text                 | snapshot achatado do endereço                  |
| `subtotal_cents`                     | int                  |                                                |
| `discount_cents`                     | int                  | desconto de **produto**                        |
| `coupon_code`                        | text?                | cupom aplicado                                 |
| `coupon_discount_cents`              | int                  | desconto de **cupom** (separado)               |
| `shipping_cents`                     | int                  |                                                |
| `total_cents`                        | int                  | `subtotal − discount − couponDiscount + frete` |
| `shipping_service` / `shipping_days` | text?                |                                                |
| `payment_status`                     | `PaymentStatus`      | default `pending`                              |
| `payment_method`                     | text                 |                                                |
| `shipping_status`                    | `ShippingStatus`     | default `pending`                              |
| `internal_note`                      | text?                |                                                |
| `asaas_payment_id`                   | text? **unique**     | elo anti-replay com o webhook                  |
| `asaas_customer_id`                  | text?                |                                                |
| `checkout_key`                       | text? **unique**     | idempotência de checkout (reaproveita pedido)  |
| `stock_reserved`                     | bool                 | flag idempotente do ciclo de reserva           |
| `stock_committed`                    | bool                 | flag idempotente da baixa de estoque           |
| `due_date`                           | timestamptz?         | vencimento do PIX (fonte única do pg_cron)     |
| `created_at`                         | timestamptz          |                                                |

Índices: `userId`, `createdAt`, `paymentStatus`, `stockReserved`.

### `order_items`

Snapshots no momento da compra (sobrevivem a alterações do produto).

| Coluna             | Tipo                 | Notas                  |
| ------------------ | -------------------- | ---------------------- |
| `id`               | uuid PK              |                        |
| `order_id`         | int FK → `orders`    | `onDelete: Cascade`    |
| `product_id`       | uuid FK → `products` |                        |
| `product_name`     | text                 | snapshot               |
| `quantity`         | int                  |                        |
| `unit_price_cents` | int                  | snapshot do preço pago |

Índices: `order_id`, `product_id`.

### `audit_log` — trilha imutável de mutações de admin

`entity_id` é `text` para acomodar id de produto (uuid), pedido (int) e cupom
(uuid). `before`/`after` são snapshots do domínio serializados em JSONB.

| Coluna                | Tipo              | Notas |
| --------------------- | ----------------- | ----- |
| `id`                  | uuid PK           |       |
| `actor_clerk_user_id` | text?             |       |
| `actor_email`         | text?             |       |
| `actor_role`          | `Role`?           |       |
| `action`              | `AuditAction`     |       |
| `entity_type`         | `AuditEntityType` |       |
| `entity_id`           | text              |       |
| `before` / `after`    | jsonb?            |       |
| `request_id`          | text?             |       |
| `ip`                  | text?             |       |
| `created_at`          | timestamptz       |       |

Índices: `(entity_type, entity_id)`, `created_at`, `actor_clerk_user_id`.

### `webhook_events` — ledger de eventos de provedores

`(provider, event_id)` único barra reprocessamento. `processed_at = NULL`
significa recebido mas ainda não concluído (reentrada segura).

| Coluna         | Tipo         | Notas                          |
| -------------- | ------------ | ------------------------------ |
| `id`           | uuid PK      |                                |
| `provider`     | text         | ex.: `asaas`                   |
| `event_id`     | text         | (Asaas: `payment.id \| event`) |
| `type`         | text         |                                |
| `payload`      | jsonb?       |                                |
| `received_at`  | timestamptz  |                                |
| `processed_at` | timestamptz? |                                |

Único: `(provider, event_id)`. Índices: `received_at`, `processed_at`.

### `coupons`

`type='percent'` usa `percent_off`; `type='fixed'` usa `value_cents` (CHECK no DB
garante a coerência). O código é **único case-insensitive** via índice em
`LOWER(code)` (criado na migration, não declarado `@unique` no schema).

| Coluna                      | Tipo         | Notas                                 |
| --------------------------- | ------------ | ------------------------------------- |
| `id`                        | uuid PK      |                                       |
| `code`                      | text         | único por `LOWER(code)`               |
| `type`                      | `CouponType` |                                       |
| `percent_off`               | int?         | usado quando `percent`                |
| `value_cents`               | int?         | usado quando `fixed`                  |
| `min_subtotal_cents`        | int          | default 0                             |
| `max_redemptions`           | int?         | limite global                         |
| `per_user_limit`            | int?         | limite por usuário                    |
| `redeemed_count`            | int          | incrementado atomicamente na redenção |
| `is_active`                 | bool         | default true                          |
| `starts_at` / `expires_at`  | timestamptz? |                                       |
| `created_at` / `updated_at` | timestamptz  |                                       |

Índice: `is_active`.

**CRUD (admin, `/admin/cupons`):** criar · editar · inativar/reativar · **excluir**.
A exclusão é permanente e só é permitida para cupom **sem nenhuma redenção** — a FK
`coupon_redemptions.coupon_id` é `onDelete: Restrict` e o histórico é fiscal/auditável;
cupom já usado deve ser **inativado**. Toda mutação grava `audit_log` na mesma transação.

### `coupon_redemptions`

Uma linha por uso efetivo, vinculada ao pedido. Idempotente por pedido
(`order_id` **unique**): redimir o mesmo pedido 2x é no-op.

| Coluna                     | Tipo                         | Notas                                      |
| -------------------------- | ---------------------------- | ------------------------------------------ |
| `id`                       | uuid PK                      |                                            |
| `coupon_id`                | uuid FK → `coupons`          | `onDelete: Restrict`                       |
| `order_id`                 | int FK → `orders` **unique** | `onDelete: Cascade`                        |
| `clerk_user_id` (`userId`) | text                         |                                            |
| `discount_cents`           | int                          | abatimento efetivo (recalculado no server) |
| `created_at`               | timestamptz                  |                                            |

Índices: `coupon_id`, `userId`.

---

## Fluxos principais

### Checkout e pagamento PIX

1. O cliente aplica cupom (opcional) e confirma o checkout (`Server Action`).
2. `createOrderWithReservation` cria o pedido e **reserva o estoque** numa
   transação. Com cupom, usa isolamento `Serializable` + retry para fechar a
   corrida do limite por usuário; sem cupom, `READ COMMITTED` com colapso por
   `checkout_key` (idempotência).
3. No Asaas: `createCustomer` → `createPixCharge` (POST `/payments`, `billingType:
PIX`, `externalReference` = id do pedido) → `getPixQrCode` (copia-e-cola +
   imagem).
4. A tela exibe o PIX; `due_date` (derivado de `PIX_DUE_DAYS`) é a fonte única do
   vencimento usada pelo pg_cron.

> Frete: grátis acima de **R$ 299** em mercadorias (já descontadas); caso
> contrário, flat de **R$ 25** (`lib/cart/totals.ts`).

### Webhook do Asaas (`/api/webhooks/asaas`)

Confirma/cancela o pagamento. Idempotência em duas camadas, **na mesma
transação** do efeito:

1. Ledger `webhook_events` com `event_id = payment.id | event` — reenvio do mesmo
   par vira no-op.
2. Anti-replay por `asaas_payment_id` + compare-and-swap + conciliação de estoque
   dentro de `applyPaymentStatusTx`.

Em `paid`, baixa o estoque reservado (commit) e dispara o e-mail de confirmação.
Erro transitório responde **500** para o Asaas reenviar (reprocessamento seguro
enquanto `processed_at IS NULL`). Autenticação por token no header
`asaas-access-token` (comparação em tempo constante).

### Webhook do Clerk (`/api/webhooks/clerk`)

Verifica a assinatura `svix` e sincroniza a tabela `users` (`user.created/updated`
→ upsert; `user.deleted` → remove). E-mails listados em `ADMIN_EMAILS` recebem
role `admin` no upsert (bootstrap de admin sem mexer no banco).

### Reconciliação (`/api/internal/reconcile-orders`)

Rota interna chamada **apenas** pelo job pg_cron via `pg_net`. Varre pedidos
`pending` antigos (≥ 30 min, lotes de 50) com `asaas_payment_id`, consulta o
status real no Asaas e aplica `setOrderPaymentStatus` (mesma idempotência do
webhook). Como só toca `pending`, nunca cancela um pedido já pago. Autenticação
por segredo no header `x-cron-secret` (tempo constante; fail-closed).

---

## Jobs de pg_cron

Definidos em `prisma/migrations/20260615060000_pgcron`. Rodam no banco do
scheduler (no Supabase, o database `postgres`). Segredos/URL vêm de GUCs
(`app.settings.reconcile_url` / `reconcile_secret`), definidas uma vez fora do
git — sem elas, o job de reconciliação é no-op (fail-closed).

| Job                                  | Frequência       | O que faz                                                                                                   |
| ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `rmcards-expire-overdue-orders`      | a cada 15 min    | Cancela pedidos `pending` com PIX vencido e estorna a reserva de estoque (idempotente via `stock_reserved`) |
| `rmcards-deactivate-expired-coupons` | 1×/hora (min 5)  | `is_active=false` para cupons com `expires_at < now()`                                                      |
| `rmcards-reconcile-pending-orders`   | a cada 10 min    | Dispara POST para a rota interna de reconciliação (billing fica no TS)                                      |
| `rmcards-purge-webhook-events`       | diário 03:30 UTC | Remove `webhook_events` processados há > 90 dias (audit_log **não** é purgado)                              |

Inspecionar:

```sql
SELECT jobid, schedule, jobname, active FROM cron.job WHERE jobname LIKE 'rmcards-%';
SELECT * FROM cron.job_run_details
  WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname LIKE 'rmcards-%')
  ORDER BY start_time DESC LIMIT 50;
```

---

## Variáveis de ambiente

Copie `.env.example` para `.env.local` e preencha. Em dev mock-first, deixar
vazio **não quebra** a aplicação.

| Variável                                                               | Descrição                                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                                                  | URL pública do app                                                         |
| `NEXT_PUBLIC_WHATSAPP_NUMBER`                                          | Número do botão flutuante de WhatsApp                                      |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`               | Chaves do Clerk                                                            |
| `CLERK_WEBHOOK_SECRET`                                                 | Signing secret (svix) do webhook do Clerk                                  |
| `ADMIN_EMAILS`                                                         | E-mails (separados por vírgula) que viram admin no sync                    |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` etc.                                   | Rotas/redirects do Clerk                                                   |
| `DATABASE_URL`                                                         | Postgres via pooler (porta 6543, `pgbouncer=true`) — runtime               |
| `DIRECT_URL`                                                           | Conexão direta (porta 5432) — migrations                                   |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase                                                                   |
| `ASAAS_API_URL`                                                        | Ex.: `https://api-sandbox.asaas.com/v3`                                    |
| `ASAAS_API_KEY`                                                        | ⚠️ começa com `$`; escape como `"\$aact_..."` (senão o dotenv-expand zera) |
| `ASAAS_WEBHOOK_TOKEN`                                                  | Token do header `asaas-access-token`                                       |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL`                                 | E-mail transacional                                                        |
| `CRON_RECONCILE_SECRET`                                                | Segredo compartilhado entre pg_cron e a rota interna                       |

---

## Como rodar localmente

Pré-requisitos: **Node 20+** e **pnpm 10**.

```bash
pnpm install              # instala (postinstall roda prisma generate)
cp .env.example .env.local

# Modo mock-first: dá pra subir sem nenhum segredo
pnpm dev                  # http://localhost:3000
```

Com banco real (Postgres/Supabase):

```bash
# preencha DATABASE_URL e DIRECT_URL no .env.local
pnpm db:migrate           # aplica as migrations
pnpm db:seed              # popula o catálogo inicial
pnpm dev
```

> Sem chaves de Clerk, as rotas protegidas (`/admin`, `/minhas-compras`,
> `/checkout`) ficam abertas — útil em dev. Em produção, builde com as chaves
> reais preenchidas.

---

## Scripts

| Script                         | Ação                                 |
| ------------------------------ | ------------------------------------ |
| `pnpm dev`                     | Servidor de desenvolvimento          |
| `pnpm build`                   | `prisma generate` + `next build`     |
| `pnpm start`                   | Servidor de produção                 |
| `pnpm lint`                    | ESLint (`--max-warnings 0`)          |
| `pnpm typecheck`               | `tsc --noEmit`                       |
| `pnpm format` / `format:check` | Prettier (write / check)             |
| `pnpm db:generate`             | Gera o Prisma Client                 |
| `pnpm db:migrate`              | `prisma migrate dev`                 |
| `pnpm db:seed`                 | Popula o catálogo (`prisma/seed.ts`) |
| `pnpm db:studio`               | Prisma Studio                        |

---

## Banco e migrations

Prisma 7 com **driver adapter** (`@prisma/adapter-pg` sobre node-postgres). O
client é gerado em `lib/generated/prisma` (gitignored) e exposto como singleton
em `lib/db.ts`. O adapter não cacheia prepared statements, então é seguro usar o
**pooler em transaction-mode** (`DATABASE_URL`, 6543); migrations usam a conexão
direta (`DIRECT_URL`, 5432), configurada em `prisma.config.ts`.

Migrations versionadas em `prisma/migrations/`:

| Migration                  | Conteúdo                                            |
| -------------------------- | --------------------------------------------------- |
| `…_init`                   | Tabelas base (users, products, orders, order_items) |
| `…_add_asaas_payment_refs` | Colunas de correlação com o Asaas                   |
| `…_add_users`              | Sincronização de usuários do Clerk                  |
| `…_foundation_hardening`   | CHECKs de estoque, cupons, auditoria, idempotência  |
| `…_pgcron`                 | Funções e agendamento dos jobs (pg_cron + pg_net)   |

---

## CI

GitHub Actions (`.github/workflows/ci.yml`) roda em push para `main` e em PRs,
com **placeholders dummy** (nunca segredos reais — graças ao mock-first):

`pnpm install` → `db:generate` → `typecheck` → `lint` (zero warnings) →
`format:check` → `build`.

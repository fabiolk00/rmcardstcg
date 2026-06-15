# RM Cards — Auditoria multiagente: relatório e estado

Auditoria de correção/concorrência conduzida com o setup de `ORCHESTRATION.md`
(4 auditores de domínio em paralelo — billing, stock, users, N+1 — + QA
adversarial). Cada fix passa pelo `scripts/qa-gate.sh` (typecheck · lint ·
format · `test:nplusone` · build) e os de domínio têm prova contra um Postgres
real (opt-in por `TEST_DATABASE_URL`; ver `tests/nplusone/README.md`).

## ✅ Corrigidos

| Achado                                                                                                                 | Sev. | Domínio       | Commit    | Prova                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | ---- | ------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/minhas-compras` chamava `getOrders()` (pedidos de TODOS os clientes) — IDOR/PII                                      | 🔴   | users         | `dc904cb` | usa `getOrdersByUserId(userId)` resolvido via Clerk                                                                                                   |
| Checkout fazia `getProductById` por item (N+1)                                                                         | 🟠   | nplusone      | `dc904cb` | `getProductsByIds` (1 query) + harness `tests/nplusone`                                                                                               |
| Reconciliação de estoque decidia sobre snapshot lido sem lock → duplo-restock e "pago sem baixa" sob concorrência      | 🔴   | billing+stock | `d78f2bb` | CAS no flip da flag (row-lock); `tests/concurrency`                                                                                                   |
| `expire_overdue_orders()` cancelava pedido vencido sem reconsultar o Asaas → cancelava venda paga cujo webhook atrasou | 🔴   | billing       | `7db6640` | grace window de 60 min; `tests/expiry`                                                                                                                |
| Ajuste de estoque do admin ignorava `reserved` → 500 opaco por violar o CHECK                                          | 🟠   | stock         | `7db6640` | `updateProduct` rejeita com msg clara; `tests/admin`                                                                                                  |
| Client Asaas sem retry/backoff                                                                                         | 🟡   | billing       | `ef0917a` | retry GET-only (POST nunca) + backoff/jitter; `tests/services`                                                                                        |
| `uniqueSlug` fazia 1 query por colisão                                                                                 | 🟡   | nplusone      | `ef0917a` | `findMany` único + sufixo em memória; `tests/products`                                                                                                |
| `per_user_limit` dependia só de SSI; sem respaldo sob pgbouncer                                                        | 🟠   | users         | `23670bf` | advisory lock transacional por (cupom,usuário) torna o limite determinístico mesmo em READ COMMITTED; `tests/coupons` (falha sem o lock: 2 redenções) |
| Mensagem de cupom era oráculo de enumeração (not_found vs esgotado distinguíveis)                                      | 🟠   | users         | `23670bf` | `couponErrorMessage` colapsa motivos que revelam existência numa msg genérica; `tests/cart`                                                           |
| Catálogo (`colecoes`) sem cache → risco de thundering herd no pooler                                                   | 🟡   | nplusone      | `23670bf` | `unstable_cache` (60s) mantendo `force-dynamic` (não quebra o build mock-first)                                                                       |

## 🔓 Abertos / adiados (com motivo)

| Achado                                                    | Sev. | Por que NÃO foi aplicado agora                                                                                                                                                                                                                                                                 | Abordagem proposta                                                                                 |
| --------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Rate limiting volumétrico (spam de checkout/cupom)        | 🟠   | A enumeração de cupom foi mitigada (msg genérica), mas o limite por volume precisa de **store compartilhado** (Upstash/Vercel KV/Redis); limiter em memória é inócuo em serverless multi-instância. Limitar o checkout exige cuidado p/ não bloquear retries idempotentes (mesma checkoutKey). | Token bucket por IP/usuário+rota via KV, isentando retries por `checkoutKey`.                      |
| Guard de build: falhar se `NODE_ENV=production` sem Clerk | 🟡   | **Quebraria o CI**: o build de CI usa chaves Clerk placeholder → `isClerkConfigured()` é `false`. Um guard duro reprovaria o build hermético.                                                                                                                                                  | Verificação em runtime no boot de produção (não no build) + checklist de deploy.                   |
| UI de checkout mostra total **sem** o cupom               | 🟡   | Regra de frete no servidor já é correta e determinística. Corrigir a UI exige uma server action de **preview de cupom** (validação é server-only) — trabalho de feature.                                                                                                                       | Endpoint/preview server de cupom devolvendo desconto + total final para a `CheckoutView` refletir. |
| Reconcile re-busca `getOrderById` por pedido pago         | 🟡   | 1 query extra por pedido pago reconciliado (lote ≤50), não um N+1 por item. Refatorar mexe na assinatura de retorno do caminho de pagamento.                                                                                                                                                   | `applyPaymentStatusTx` retornar o `Order` (já seleciona `items`) p/ o e-mail.                      |
| `inventory.ts` faz 1 UPDATE por item                      | 🟡   | São N round-trips dentro de **uma** transação (N = itens do carrinho, pequeno). Batch em `reserveStock` complica a identificação do item sem estoque, no caminho crítico recém-endurecido.                                                                                                     | `UPDATE … WHERE id = ANY($1::uuid[])` para release/commit/restock; `reserveStock` com `RETURNING`. |
| Rebaixamento de admin impossível via `ADMIN_EMAILS`       | 🟡   | Decisão de política. O padrão atual ("nunca rebaixa admin existente") é seguro/anti-flap.                                                                                                                                                                                                      | Ação de admin auditada para alterar role; documentar que `ADMIN_EMAILS` concede, não revoga.       |
| `user.deleted` deixa `orders`/`redemptions` órfãos        | ⚪   | **Intencional/desejável**: preservar pedidos por questão fiscal/auditoria; FK-por-texto desacopla do Clerk.                                                                                                                                                                                    | Sem mudança; documentado.                                                                          |
| Webhook sem teto explícito de payload                     | ⚪   | Limites de plataforma já cobrem.                                                                                                                                                                                                                                                               | `Content-Length` → 413 acima de um teto, se desejado.                                              |

## Como rodar as provas

```bash
# Postgres descartável + schema (ver tests/nplusone/README.md)
export TEST_DATABASE_URL="postgresql://postgres:test@HOST:5432/db"
pnpm test               # todas as suites (sem TEST_DATABASE_URL, as de DB são puladas)
```

`scripts/qa-gate.sh` continua verde sem banco (suites de DB são opt-in; `build`
exige apenas as envs dummy do CI).

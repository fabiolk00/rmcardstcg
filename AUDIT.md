# RM Cards — Auditoria multiagente: relatório e estado

Auditoria de correção/concorrência conduzida com o setup de `ORCHESTRATION.md`
(4 auditores de domínio em paralelo — billing, stock, users, N+1 — + QA
adversarial). Cada fix passa pelo `scripts/qa-gate.sh` (typecheck · lint ·
format · `test:nplusone` · build) e os de domínio têm prova contra um Postgres
real (opt-in por `TEST_DATABASE_URL`; ver `tests/nplusone/README.md`).

## ✅ Corrigidos

| Achado                                                                                                            | Sev. | Domínio       | Commit    | Prova                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ---- | ------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `/minhas-compras` chamava `getOrders()` (pedidos de TODOS os clientes) — IDOR/PII                                 | 🔴   | users         | `dc904cb` | usa `getOrdersByUserId(userId)` resolvido via Clerk                                                 |
| Checkout fazia `getProductById` por item (N+1)                                                                    | 🟠   | nplusone      | `dc904cb` | `getProductsByIds` (1 query) + harness `tests/nplusone`                                             |
| Reconciliação de estoque decidia sobre snapshot lido sem lock → duplo-restock e "pago sem baixa" sob concorrência | 🔴   | billing+stock | `d78f2bb` | CAS no flip da flag (row-lock); `tests/concurrency`                                                 |
| `expire_overdue_orders()` cancelava pedido vencido sem reconsultar o Asaas                                        | 🔴   | billing       | `7db6640` | grace window de 60 min; `tests/expiry`                                                              |
| Ajuste de estoque do admin ignorava `reserved` → 500 opaco                                                        | 🟠   | stock         | `7db6640` | `updateProduct` rejeita com msg clara; `tests/admin`                                                |
| Client Asaas sem retry/backoff                                                                                    | 🟡   | billing       | `ef0917a` | retry GET-only (POST nunca) + backoff/jitter; `tests/services`                                      |
| `uniqueSlug` fazia 1 query por colisão                                                                            | 🟡   | nplusone      | `ef0917a` | `findMany` único; `tests/products`                                                                  |
| `per_user_limit` dependia só de SSI                                                                               | 🟠   | users         | `23670bf` | advisory lock transacional por (cupom,usuário); `tests/coupons`                                     |
| Mensagem de cupom era oráculo de enumeração                                                                       | 🟠   | users         | `23670bf` | `couponErrorMessage` colapsa motivos que revelam existência; `tests/cart`                           |
| Catálogo sem cache → thundering herd                                                                              | 🟡   | nplusone      | `23670bf` | `unstable_cache` (60s) mantendo `force-dynamic`                                                     |
| UI de checkout mostrava total **sem** o cupom (mostra X, cobra Y)                                                 | 🟡   | users         | `a0f3716` | `previewCoupon` (mesma fórmula do checkout) + `CheckoutView`; `tests/cart/coupon-total`             |
| Ausência de rate limiting (spam/enumeração de checkout/cupom)                                                     | 🟠   | users         | `a0f3716` | limiter plugável (`lib/security/rateLimit`) em checkout + preview, por usuário/IP; `tests/security` |
| Sem aviso ao subir em produção sem Clerk                                                                          | 🟡   | users         | `a0f3716` | aviso de runtime no `middleware` (não fatal; não quebra o build)                                    |

> **Nota de deploy (rate limiting):** o default é uma janela em memória **por
> instância** — eficaz contra abuso de fonte única, mas em serverless
> multi-instância injete um store compartilhado via `setRateLimitStore()` no boot
> (interface `RateLimitStore` pronta p/ Upstash/Vercel KV/Redis).

## 🔓 Abertos / adiados (recomendo deixar como está — com motivo)

| Achado                                             | Sev. | Por que deixar                                                                                                                                                              | Se for mexer                                                                                     |
| -------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Reconcile re-busca `getOrderById` por pedido pago  | 🟡   | 1 query extra por pedido pago reconciliado (lote ≤50), não um N+1 por item. Refatorar mexe na assinatura de retorno do caminho de pagamento — risco > ganho.                | `applyPaymentStatusTx` retornar o `Order` (já seleciona `items`) p/ o e-mail.                    |
| `inventory.ts` faz 1 UPDATE por item               | 🟡   | N round-trips dentro de **uma** transação (N = itens do carrinho, pequeno). Batch em `reserveStock` complica achar o item sem estoque, no caminho crítico recém-endurecido. | `UPDATE … WHERE id = ANY($1::uuid[])` p/ release/commit/restock; `reserveStock` com `RETURNING`. |
| Rebaixamento de admin via `ADMIN_EMAILS`           | 🟡   | Tornar `ADMIN_EMAILS` autoritativo **rebaixaria admins promovidos via DB** no próximo sync — pior que o problema. O default "nunca rebaixa" é seguro/anti-flap.             | Ação de admin **explícita e auditada** para alterar role (feature), não mudar o sync.            |
| `user.deleted` deixa `orders`/`redemptions` órfãos | ⚪   | **Intencional/desejável**: preservar pedidos por questão fiscal/auditoria; FK-por-texto desacopla do Clerk.                                                                 | Soft-delete do espelho, se algum dia for requisito.                                              |
| Webhook sem teto explícito de payload              | ⚪   | Limites de plataforma já cobrem.                                                                                                                                            | `Content-Length` → 413 acima de um teto.                                                         |

## Como rodar as provas

```bash
# Postgres descartável + schema (ver tests/nplusone/README.md)
export TEST_DATABASE_URL="postgresql://postgres:test@HOST:5432/db"
pnpm test               # todas as suites (sem TEST_DATABASE_URL, as de DB são puladas)
```

`scripts/qa-gate.sh` continua verde sem banco (suites de DB são opt-in; `build`
exige apenas as envs dummy do CI).

# RM Cards — Auditoria multiagente: relatório e estado

Auditoria de correção/concorrência conduzida com o setup de `ORCHESTRATION.md`
(4 auditores de domínio em paralelo — billing, stock, users, N+1 — + QA
adversarial). Cada fix passa pelo `scripts/qa-gate.sh` (typecheck · lint ·
format · `test:nplusone` · build) e os de domínio têm prova contra um Postgres
real (opt-in por `TEST_DATABASE_URL`; ver `tests/nplusone/README.md`).

## ✅ Corrigidos

| Achado                                                                                                            | Sev. | Domínio       | Commit    | Prova                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ---- | ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/minhas-compras` chamava `getOrders()` (pedidos de TODOS os clientes) — IDOR/PII                                 | 🔴   | users         | `dc904cb` | usa `getOrdersByUserId(userId)` resolvido via Clerk                                                                                               |
| Checkout fazia `getProductById` por item (N+1)                                                                    | 🟠   | nplusone      | `dc904cb` | `getProductsByIds` (1 query) + harness `tests/nplusone`                                                                                           |
| Reconciliação de estoque decidia sobre snapshot lido sem lock → duplo-restock e "pago sem baixa" sob concorrência | 🔴   | billing+stock | `d78f2bb` | CAS no flip da flag (row-lock); `tests/concurrency`. **Residual** (ressurreição `cancelled→paid`) fechado em `8a0867b` — ver rodada de fechamento |
| `expire_overdue_orders()` cancelava pedido vencido sem reconsultar o Asaas                                        | 🔴   | billing       | `7db6640` | grace window de 60 min; `tests/expiry`                                                                                                            |
| Ajuste de estoque do admin ignorava `reserved` → 500 opaco                                                        | 🟠   | stock         | `7db6640` | `updateProduct` rejeita com msg clara; `tests/admin`                                                                                              |
| Client Asaas sem retry/backoff                                                                                    | 🟡   | billing       | `ef0917a` | retry GET-only (POST nunca) + backoff/jitter; `tests/services`                                                                                    |
| `uniqueSlug` fazia 1 query por colisão                                                                            | 🟡   | nplusone      | `ef0917a` | `findMany` único; `tests/products`                                                                                                                |
| `per_user_limit` dependia só de SSI                                                                               | 🟠   | users         | `23670bf` | advisory lock transacional por (cupom,usuário); `tests/coupons`                                                                                   |
| Mensagem de cupom era oráculo de enumeração                                                                       | 🟠   | users         | `23670bf` | `couponErrorMessage` colapsa motivos que revelam existência; `tests/cart`                                                                         |
| Catálogo sem cache → thundering herd                                                                              | 🟡   | nplusone      | `23670bf` | `unstable_cache` (60s) mantendo `force-dynamic`                                                                                                   |
| UI de checkout mostrava total **sem** o cupom (mostra X, cobra Y)                                                 | 🟡   | users         | `a0f3716` | `previewCoupon` (mesma fórmula do checkout) + `CheckoutView`; `tests/cart/coupon-total`                                                           |
| Ausência de rate limiting (spam/enumeração de checkout/cupom)                                                     | 🟠   | users         | `a0f3716` | limiter plugável (`lib/security/rateLimit`) em checkout + preview, por usuário/IP; `tests/security`                                               |
| Sem aviso ao subir em produção sem Clerk                                                                          | 🟡   | users         | `a0f3716` | aviso de runtime no `middleware` (não fatal; não quebra o build)                                                                                  |

> **Nota de deploy (rate limiting):** o default é uma janela em memória **por
> instância** — eficaz contra abuso de fonte única, mas em serverless
> multi-instância injete um store compartilhado via `setRateLimitStore()` no boot
> (interface `RateLimitStore` pronta p/ Upstash/Vercel KV/Redis).

### Rodada de fechamento dos itens adiados (fix → QA → review → fix)

Os itens antes listados em "🔓 Abertos / adiados" foram tratados nesta rodada
(times por domínio: stock → billing → users; + `qa-gate` adversarial com prova em
Postgres real). Funcionalidade nova relacionada: exclusão permanente de cupom
(`8c624d1`, `/admin/cupons`).

| Achado                                                                                   | Sev. | Domínio       | Commit              | Prova                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ---- | ------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory.ts` fazia 1 UPDATE por item                                                   | 🟡   | stock         | `0a2ca6d`           | batch `UPDATE … FROM (VALUES …)` (agrega duplicados; `RETURNING` acha o item sem estoque); `tests/stock/batch`                                                                                                                                                            |
| Reconcile re-buscava `getOrderById` por pedido pago                                      | 🟡   | billing       | `5086430`           | `applyPaymentStatusTx` retorna o `Order` (leitura única); `tests/concurrency/payment-status-order-return`                                                                                                                                                                 |
| Webhook Asaas sem teto de payload                                                        | ⚪   | billing       | `5086430`           | 413 por `Content-Length` declarado **e** por tamanho real; `tests/security/webhook-payload-cap`                                                                                                                                                                           |
| Sem ação **auditada** para alterar role (sync nunca rebaixa)                             | 🟡   | users         | `93d6d76`           | `setUserRole` auditada + `/admin/usuarios` (anti-lockout; sync intacto); `tests/users/set-user-role`                                                                                                                                                                      |
| `user.deleted` deixava `orders`/`redemptions` órfãos                                     | ⚪   | users         | `93d6d76`           | soft-delete do espelho (`users.deleted_at`; leituras filtram); `tests/users/soft-delete`                                                                                                                                                                                  |
| **Ressurreição `cancelled→paid`** (residual de `d78f2bb`) → "pago sem baixa" sob corrida | 🔴   | billing+stock | `8a0867b` `7023503` | guarda de transição em `applyPaymentStatusTx`: `8a0867b` fecha `cancelled→paid`; `7023503` generaliza p/ a máquina de estados completa (`PAYMENT_TRANSITIONS`) após sign-off do QA. `tests/concurrency/payment-status-terminal` (matriz determinística) + corrida estável |

> **Achado do QA (independente):** ao rodar a suíte completa contra um Postgres
> real, o `qa-gate` flagrou que a corrida `cron-cancel × webhook-paid` ainda deixava
> "pago sem baixa de estoque" — o `d78f2bb` fechou o CAS das flags de estoque, mas
> **não** a transição de status: o CAS `WHERE payment_status = <valor lido>`
> ressuscitava para `paid` um pedido já cancelado/estornado (reserva já revertida ⇒
> o reconcile de `paid` não baixa). Reproduzido **deterministicamente** e fechado em
> `8a0867b`. No sign-off seguinte o `qa-gate` aprovou e observou que `paid→pending`/
> `cancelled→pending` (inalcançáveis pelos callers atuais) também passariam pelo CAS;
> `7023503` generalizou a guarda para a máquina de estados completa. É o loop
> fix→QA→review→fix funcionando: o QA derrubou o estado anterior, o fix novo passou.

## 🔓 Abertos / adiados

Os 5 itens antes listados aqui (reconcile N+1, inventory batch, role via
`ADMIN_EMAILS`, órfãos de `user.deleted`, teto de payload) foram **todos
endereçados** na rodada de fechamento acima. Nenhum item de severidade ≥🟡 em
aberto.

**Notas residuais (sem ação imediata):**

- **`ADMIN_EMAILS` re-promove no sync:** rebaixar via `/admin/usuarios` um e-mail que
  ainda está em `ADMIN_EMAILS` é revertido no próximo `user.updated` do Clerk
  (bootstrap allowlist "nunca rebaixa"). Esperado — para rebaixar em definitivo,
  remova o e-mail de `ADMIN_EMAILS`. Por isso o sync **não** foi alterado; só foi
  adicionada a ação auditada.
- **CHECK `products_reserved_le_stock_chk` só nas migrations:** a constraint vive no
  SQL versionado (aplicada por `prisma migrate` em CI/prod), não no `schema.prisma` —
  logo um setup de teste por `prisma db push` não a cria (nesse caso a proteção é só
  nos guards da aplicação). Sem impacto em produção; afeta só a fidelidade de
  ambientes `db push`.
- **Rate limiting em memória por instância:** ver a nota de deploy acima (injete um
  store compartilhado em serverless multi-instância).
- **Último admin:** a guarda anti-lockout impede o admin de rebaixar a **si mesmo**,
  mas não impede que o último admin seja rebaixado por **outro** admin (fora do
  escopo desta rodada).

## Como rodar as provas

```bash
# Postgres descartável + schema (ver tests/nplusone/README.md)
export TEST_DATABASE_URL="postgresql://postgres:test@HOST:5432/db"
pnpm test               # todas as suites (sem TEST_DATABASE_URL, as de DB são puladas)
```

`scripts/qa-gate.sh` continua verde sem banco (suites de DB são opt-in; `build`
exige apenas as envs dummy do CI).

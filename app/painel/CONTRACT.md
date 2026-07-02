# CONTRATO CONGELADO — Painel do Cliente (SYNC 0, 2026-07-02)

Mudança só com reconciliação entre donos. Fontes: código lido no SYNC 0.

## Decisão de rota (reconciliada com o programa)

O shell do dashboard existente é o **admin** (`app/admin/layout.tsx` + `admin.module.css`),
gated a role admin — o cliente NÃO entra nele. O painel do cliente é um shell IRMÃO em
`app/painel/**`, **replicando o estilo do admin** (mesmas classes-padrão: `.shell/.sidebar/
.brand/.main/.topbar/.content`, mesmos tokens de `app/globals.css`, CSS Modules por arquivo —
o método de estilo do projeto). Fundação-primeiro substitui a camada de stubs: o Agente A
entrega o shell real antes das telas; nenhum agente fica ocioso.

## Rotas (montam como children do layout `app/painel/layout.tsx`)

| Rota | Dono | Conteúdo |
|---|---|---|
| `/painel` | A | redirect → `/painel/pedidos` |
| `/painel/conta` | B | formulário de perfil/endereço |
| `/painel/colecoes` | C | vitrine (reusa `ColecoesView`) |
| `/painel/pedidos` | D | tabela de pedidos (linha → detalhe EXISTENTE `/minhas-compras/[id]`) |
| `/painel/carrinho` | E | reusa `CartView` |
| `/painel/checkout` | E | reusa `CheckoutView` com prefill do perfil |

`/minhas-compras*` (lista/detalhe/recibo) PERMANECE intacta — o painel linka para o
detalhe/recibo existentes, não os recria.

## RBAC (contrato)

- Guard do painel = `requireActiveUser` (`lib/auth/requireActiveUser.ts`): login +
  espelho ativo. `unauthenticated` → redirect `/entrar`; `deleted` → redirect `/`.
  Mock-first (sem Clerk): guest navega (padrão do repo).
- Middleware (`proxy.ts`): A adiciona `"/painel(.*)"` ao matcher protegido.
- Rotas admin continuam negadas a cliente pelo guard EXISTENTE (`app/admin/layout.tsx:26`
  redirect "/") — nada a fazer, não tocar.
- `pos-login`: cliente → `/painel/pedidos` (A edita; admin segue → `/admin/produtos`).
- Topbar storefront: item do UserButton passa a apontar `/painel/pedidos` (A edita
  `components/layout/AuthControls.tsx`).

## Reuso visual (proibido estilo novo)

- Tokens: variáveis de `app/globals.css` (`--bg, --ink, --border, --r-sm...`).
- Shell: replicar `app/admin/admin.module.css` em `app/painel/painel.module.css`
  (copiar classes, ajustar só o rótulo "Painel do cliente").
- Sidebar: `components/cliente/ClienteNav.tsx` no molde EXATO de `AdminNav.tsx`
  (usePathname + `Icon` de `components/ui/Icon`), itens: Conta (`user`),
  Coleções (`grid`), Meus Pedidos (`receipt`), Carrinho (`box`).
- Avatar/dropdown: `components/cliente/ClienteProfileMenu.tsx` no molde de
  `AdminProfileMenu` (useClerk: `openUserProfile` + `signOut({redirectUrl:"/"})`),
  itens: Coleções → `/painel/colecoes`; Sair. Reusar `AdminProfileCard` como base
  visual SE importável sem editar (senão replicar `ClienteProfileCard`).
- Telas: tabela no padrão de `app/(storefront)/minhas-compras/minhas-compras.module.css`;
  formulário no padrão dos modais/form do admin e do CheckoutView; cards/grade =
  `ProductGrid`/`ColecoesView` existentes.
- Estados obrigatórios em toda tela: carregando (quando client-side), vazio e erro.

## Contratos de dados por tela

### Perfil/endereço (B produz; E consome)
`schema.prisma` (B é o ÚNICO que edita o schema) — modelo novo ADITIVO:
```prisma
model CustomerProfile {
  id          String   @id @default(uuid()) @db.Uuid
  clerkUserId String   @unique @map("clerk_user_id")
  name        String
  email       String?
  phone       String
  cpfCnpj     String?  @map("cpf_cnpj")
  cep         String   // 8 dígitos, sem máscara (formatação é da UI)
  street      String
  number      String?
  complement  String?
  district    String?
  city        String
  state       String   // UF 2 letras
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  @@map("customer_profiles")
}
```
+ migration SQL em `prisma/migrations/20260702XXXXXX_add_customer_profile/`
(NÃO aplicar em banco nenhum — deploy aplica). `lib/data/profile.ts` (mock morto)
é REESCRITO por B:
- `getCustomerProfile(clerkUserId): Promise<CustomerProfile | null>` — **tolerante**:
  tabela ausente/erro de leitura → `null` + console.error (produção pode receber o
  código antes da migration; prefill degrada, não quebra).
- `saveCustomerProfile(clerkUserId, input): Promise<{ok:true} | {ok:false; error:string}>`
  (upsert por clerkUserId).
Actions (`app/painel/conta/actions.ts`, B): `requireActiveUser` + validação
(obrigatórios: name, phone, cep 8 dígitos após strip — UI exibe NNNNN-NNN —, street,
city, state UF; cpfCnpj opcional 11/14 dígitos). Autopreenchimento por CEP: NÃO existe
no projeto — não introduzir serviço externo novo.

### Alinhamento Conta → Checkout (crítico)
O form do checkout (`components/checkout/CheckoutView.tsx` Form) espera:
`{name, email, phone, cpfCnpj, cep, street, city, state}` — o perfil é SUPERSET.
Mapa de prefill: `street` do checkout = `street + ", " + number (+ complement)` quando
number existir; demais campos 1:1; cep formatado NNNNN-NNN na UI.

### Coleções (C)
Server page: MESMA fonte da vitrine (`app/(storefront)/colecoes/page.tsx` usa catálogo
ativo via lib/data/products) → `<ColecoesView products={...} initialCategory={...}/>`.
Handoff com carrinho: os cards existentes já usam `useCart().add` — o layout do painel
(A) envolve children com `<CartProvider>`; C NÃO duplica fluxo de add.

### Pedidos (D)
`getOrdersByUserId(userId)` (existente, anti-IDOR). Colunas mínimas: Pedido (link →
`/minhas-compras/{id}`), Data (desc — já vem ordenado), Itens/Produto, Pagamento,
Envio (labels de `app/(storefront)/minhas-compras/labels.ts` — importável), Total
(`formatBRL`). Vazio: mensagem + CTA → `/painel/colecoes`.

### Carrinho/Checkout (E)
- `/painel/carrinho`: `<CartView/>`. Edição ADITIVA permitida a E:
  `CartView` ganha prop opcional `checkoutHref?: string` (default `"/checkout"`,
  painel passa `"/painel/checkout"`). Storefront intacto.
- `/painel/checkout` (server page): `requireActiveUser` → `getCustomerProfile` →
  `<CheckoutView initialCustomer={perfilMapeado}/>`. Edição ADITIVA permitida a E:
  `CheckoutView` ganha prop opcional `initialCustomer?: Partial<Form>` fundida no
  estado inicial. Lógica de compra (checkout action, frete SuperFrete via
  `quoteShippingAction`, cupom, PIX) NÃO se reescreve — é o mesmo componente.

## Propriedade de arquivos

| Dono | Arquivos |
|---|---|
| Orquestrador | `app/painel/CONTRACT.md` |
| A (fundação) | `app/painel/layout.tsx`, `app/painel/page.tsx`, `app/painel/painel.module.css`, `components/cliente/**`, edições: `proxy.ts` (matcher), `app/pos-login/page.tsx` (destino cliente), `components/layout/AuthControls.tsx` (link do UserButton) |
| B | `app/painel/conta/**`, `lib/data/profile.ts`, `prisma/schema.prisma` (só o modelo novo), `prisma/migrations/*_add_customer_profile/**`, `tests/users/customer-profile*.test.ts` |
| C | `app/painel/colecoes/**` |
| D | `app/painel/pedidos/**` |
| E | `app/painel/carrinho/**`, `app/painel/checkout/**`, edições ADITIVAS: `components/cart/CartView.tsx` (prop `checkoutHref`), `components/checkout/CheckoutView.tsx` (prop `initialCustomer`) |

Regras: ninguém edita arquivo de outro dono; `git commit` só o orquestrador; cada um
roda `npx tsc --noEmit`, `npx eslint <seus arquivos> --max-warnings 0`, prettier, e
`npx vitest run` dos testes que tocar. B roda `npx prisma generate` (local, sem DB) e
`npx prisma migrate diff`? NÃO — escreve o SQL à mão no padrão das migrations existentes.

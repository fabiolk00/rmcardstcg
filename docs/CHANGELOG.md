# Changelog

## 2026-07-06 — Avaliações ocultas do frontend + consentimento LGPD no checkout

### O que mudou

- **Avaliações (reviews) deixaram de aparecer na loja.** Some a seção de avaliações da
  página de produto, a nota (estrelas) nos cards e na página do produto, a opção de
  ordenação "Melhor avaliados" em Coleções e o menu **Avaliações** do painel admin.
- **Checkout agora exige aceite explícito** dos **Termos de uso** e da **Política de
  privacidade** (checkbox obrigatório, com links para as páginas legais). O pedido só é
  criado com o aceite — validado também no servidor.

### Por quê

- Simplificar a vitrine enquanto a loja não usa avaliações de clientes.
- Reforçar conformidade com a LGPD, deixando o consentimento aos termos/privacidade
  claro e registrado no momento da compra.

### Como foi feito (sem breaking change)

- Uma única flag de ambiente controla a visibilidade: **`NEXT_PUBLIC_REVIEWS_ENABLED`**.
  - **Ausente ou diferente de `true` → avaliações OCULTAS** (comportamento novo, default).
  - **`true` → avaliações voltam** exatamente como antes (rollback é só a flag).
- **Nada foi deletado.** Os componentes de avaliação, a camada de dados
  (`lib/data/reviews.ts`) e a página de gestão no admin continuam no código — apenas sem
  superfície de UI enquanto a flag estiver desligada.

### Dados preservados (auditoria)

- A tabela `public.reviews` e suas **RLS policies** permanecem intactas no banco: todo o
  histórico de avaliações fica preservado para auditoria e para uma eventual reativação.
- Com a flag desligada, a loja **nem consulta** o domínio de avaliações (a página de
  produto pula os SELECTs de reviews) e o `aggregateRating` sai do JSON-LD (SEO), para
  não anunciar nota de uma feature oculta.

### Impacto

- **Zero breaking change.** Deploy direto, sem necessidade de rollback de dados.
- Clientes não veem mais avaliações; o acesso às políticas ficou explícito no checkout.
- A rota de gestão `/admin/avaliacoes` responde **404** enquanto a flag estiver off.

### Reativar as avaliações

1. Definir `NEXT_PUBLIC_REVIEWS_ENABLED=true` no ambiente (Vercel) e redeploy.
2. Toda a UI (produto, cards, ordenação, admin) volta a aparecer, lendo os dados que já
   estavam preservados em `public.reviews`.

### Testes

- **Unit** (`tests/config/features.test.ts`): lógica pura da flag (só `"true"` liga;
  default oculto; valores ambíguos ficam off).
- **Forma / source-scan** (`tests/features/reviews-hidden-and-consent.test.ts`, sem
  banco): valida os guards em cada superfície, o consentimento no checkout (client +
  server), a preservação da camada de dados e a **ausência de links quebrados** para
  rotas inexistentes (`/privacidade`, `/termos`, `/politica-cookies`, `/contato`).
- **E2E** (`tests/e2e/reviews-hidden.spec.ts`, `tests/e2e/checkout-consent.spec.ts`):
  produto e Coleções sem a UI de avaliações (sem "buraco" de layout) e o checkbox de
  consentimento com os links legais reais no checkout.

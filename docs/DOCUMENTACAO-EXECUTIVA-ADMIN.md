# Documentação Executiva — Painel Administrativo RM Cards

> **Para quem é este documento:** gestores, diretores e time operacional da loja. É um guia de negócio — explica **o que cada tela faz, quem usa, como usar e por que importa** — sem jargão técnico. Serve como material de treinamento da equipe e de apresentação.
>
> **Base:** mapeado diretamente do sistema real (código em produção, branch `main`), não de suposições. Onde a expectativa comum diverge do que está de fato construído, há uma nota **"⚠️ Como funciona de verdade"**.

**Loja:** RM Cards — e-commerce de cartas e produtos TCG (Pokémon e afins)
**Plataforma:** loja online + painel administrativo próprio
**Data de referência:** Julho/2026

---

## Sumário

1. [Visão geral da plataforma](#1-visão-geral-da-plataforma)
2. [Guia rápido (primeiros passos)](#2-guia-rápido-primeiros-passos)
3. [Módulo VENDAS](#3-módulo-vendas)
   - [3.1 Produtos (catálogo)](#31-produtos-catálogo)
   - [3.2 Estoque baixo](#32-estoque-baixo)
   - [3.3 Pedidos](#33-pedidos)
   - [3.4 Cupons e promoções](#34-cupons-e-promoções)
   - [3.5 Avaliações (moderação)](#35-avaliações-moderação)
4. [Módulo FINANCEIRO](#4-módulo-financeiro)
   - [4.1 Pagamentos e conciliação (Asaas / PIX)](#41-pagamentos-e-conciliação-asaas--pix)
   - [4.2 Relatórios de receita e indicadores](#42-relatórios-de-receita-e-indicadores)
5. [Módulo CLIENTES](#5-módulo-clientes)
   - [5.1 Gestão de usuários](#51-gestão-de-usuários)
   - [5.2 Permissões de acesso](#52-permissões-de-acesso)
   - [5.3 Histórico de compras](#53-histórico-de-compras)
6. [Módulo SEGURANÇA E OPERAÇÕES](#6-módulo-segurança-e-operações)
7. [Fluxos de trabalho de ponta a ponta](#7-fluxos-de-trabalho-de-ponta-a-ponta)
8. [Apêndices](#8-apêndices)
   - [A. Glossário](#a-glossário-termo-técnico--linguagem-simples)
   - [B. Matriz de permissões por papel](#b-matriz-de-permissões-por-papel)
   - [C. Checklist de setup inicial](#c-checklist-de-setup-inicial)
   - [D. Indicadores (KPIs) por tela](#d-indicadores-kpis-por-tela)
   - [E. Notas de realidade (brief × sistema)](#e-notas-de-realidade-consolidadas)
   - [F. Contatos e suporte](#f-contatos-e-suporte)

---

## 1. Visão geral da plataforma

O RM Cards é uma loja online completa, com um **painel administrativo próprio** onde a equipe controla todo o negócio: catálogo, estoque, pedidos, promoções, avaliações e acessos. Os pagamentos são feitos por **PIX** (via Asaas) e o frete é calculado automaticamente (via SuperFrete).

### O painel em um relance

O painel fica no endereço **`/admin`**. À esquerda há um menu fixo com a marca RM Cards e **seis telas**:

| # | Tela | Para quê serve |
|---|------|----------------|
| 1 | **Produtos** | Cadastrar e gerenciar o catálogo (preço, estoque, imagem, destaque) |
| 2 | **Estoque baixo** | Lista de vigilância do que precisa ser reposto |
| 3 | **Pedidos** | Acompanhar pagamentos, despachar e rastrear entregas |
| 4 | **Avaliações** | Aprovar ou rejeitar comentários de clientes antes de publicá-los |
| 5 | **Cupons** | Criar promoções e ver relatório de uso |
| 6 | **Usuários** | Ver quem tem conta e conceder/remover acesso de administrador |

### Três coisas importantes de entender desde já

1. **Só existem dois tipos de acesso: Administrador e Cliente.** Não há perfis intermediários (como "Vendedor" ou "Operador"). Quem é **admin** enxerga e faz **tudo** no painel; quem é **cliente** só usa a loja e a própria área de compras. (Ver [Matriz de permissões](#b-matriz-de-permissões-por-papel).)

2. **Não existe uma tela de "Dashboard" com gráficos gerais.** Ao entrar em `/admin`, você cai direto na tela de **Produtos**. Os indicadores existem **dentro de cada tela** — por exemplo, a tela de Pedidos mostra receita confirmada, pedidos a enviar etc. (Ver [Indicadores por tela](#d-indicadores-kpis-por-tela).)

3. **O dinheiro se resolve praticamente sozinho.** Não há uma tela de "Pagamentos". Quando o cliente paga o PIX, o pedido vira **Pago** automaticamente, o estoque baixa e um e-mail é enviado — sem ninguém clicar em nada. A equipe só age em casos de exceção. (Ver [Pagamentos e conciliação](#41-pagamentos-e-conciliação-asaas--pix).)

### Como o sistema se organiza (sem tecnês)

- **Contas e login:** cuidados por um provedor especializado (Clerk). A loja **nunca guarda senhas**.
- **Pagamento:** PIX processado pelo **Asaas** (empresa certificada). A loja **não toca em dados de cartão**.
- **Imagens:** guardadas em um repositório de arquivos na nuvem (Supabase Storage).
- **Frete:** cotado automaticamente pela SuperFrete a partir do peso/medidas do produto.

---

## 2. Guia rápido (primeiros passos)

### Como acessar o painel
1. Acesse **`/entrar`** e faça login com o e-mail cadastrado.
2. Se a sua conta tiver papel de **administrador**, você é levado ao painel (`/admin/produtos`). Caso contrário, é redirecionado para a loja.
3. O primeiro administrador da loja é liberado por uma **lista de e-mails de confiança** definida na configuração do sistema (chamada `ADMIN_EMAILS`) — assim é possível entrar antes mesmo de existir qualquer admin cadastrado. Depois disso, um admin pode promover outros pela tela de [Usuários](#51-gestão-de-usuários).

### Como cadastrar o primeiro produto
1. Menu **Produtos** → botão **"Novo Produto"**.
2. Preencha **Título**, **Categoria** e **SKU** (código único do produto).
3. Clique em **"Enviar imagem"** e selecione uma foto (PNG, JPG, WEBP ou GIF, até 4 MB). A pré-visualização aparece.
4. Escreva uma **Descrição** (até 300 caracteres — há um contador).
5. Informe **Preço base** e **Estoque**; ajuste o **Desconto** (0 a 80%) na barra deslizante. O cartão **"Preço final"** calcula sozinho.
6. (Opcional) Marque **"Landing?"** para exibir o produto na vitrine "Em destaque" da página inicial.
7. (Opcional) Ajuste a **embalagem para frete** — se deixar em branco, o sistema usa o padrão da categoria.
8. Clique em **Salvar**. O produto entra na lista já **ativo** e visível na loja.

### Como processar o primeiro pedido
1. O cliente paga o PIX → o pedido vira **Pago sozinho** (você não precisa confirmar nada).
2. Menu **Pedidos** → filtre por **"Pago"** e veja o indicador **"A enviar"**.
3. Abra o pedido em **"Mudar status"**, mude o **Envio** de "A enviar" para **"Enviado"**, escolha a **transportadora** e cole o **código de rastreio**. Salve.
4. O cliente passa a ver o rastreamento na loja. Quando entregar, volte e marque **"Entregue"**.

### Como confirmar/conciliar um pagamento (exceção)
> Na imensa maioria dos casos **você não faz nada** — o pagamento é confirmado automaticamente. Use os passos abaixo só quando um cliente pagou por fora do fluxo (ex.: comprovante) ou algo travou.

1. Menu **Pedidos** → localize o pedido → **"Mudar status"**.
2. Mude o **Pagamento** para **"Pago"**.
3. Escreva o **Motivo** (obrigatório — ex.: "confirmado via comprovante PIX"). Isso fica registrado para sempre na trilha de auditoria.
4. Salve. O estoque é acertado automaticamente.

### Como dar acesso a um novo membro da equipe
1. A pessoa precisa **criar uma conta** na loja primeiro (login normal).
2. Menu **Usuários** → busque pelo e-mail dela.
3. Na linha, clique no botão **"Admin"** (fica verde). Pronto — ela já entra no painel.
4. Para revogar depois, clique em **"Cliente"** na mesma linha.

---

## 3. Módulo VENDAS

> **Visão geral:** é o coração operacional da loja — tudo o que faz a mercadoria sair. Reúne o catálogo (Produtos), o controle do que está acabando (Estoque baixo), o processamento das vendas (Pedidos), as promoções (Cupons) e a curadoria da reputação (Avaliações). Todas as ações deste módulo ficam registradas em uma **trilha de auditoria** permanente.

```
        ┌─────────── MÓDULO VENDAS ───────────┐
        │                                      │
   [Produtos] ──cria/repõe──▶ [Estoque baixo]  │
        │                                      │
        ▼                                      │
   catálogo na loja ──cliente compra──▶ [Pedidos] ──despacha/rastreia──▶ entrega
        │                                      │
   [Cupons] ──desconto no checkout─────────────┘
        │
   [Avaliações] ◀── cliente comenta ── modera (aprova/rejeita) ──▶ vitrine
```

---

### 3.1 Produtos (catálogo)

**Rota:** `/admin/produtos`

**🎯 Objetivo.** Central onde a loja cadastra, edita e controla a disponibilidade dos produtos — definindo preço, desconto, estoque, imagem, medidas de envio e quais itens aparecem em destaque na página inicial.

**👤 Quem usa.** Administradores (dono/gestor, responsável por cadastro, precificação e catálogo). Clientes não têm acesso.

**🖥️ Como é a tela (screenshot mental).** No topo, o título **"Produtos"** com um resumo — *"X ativos · Y inativos · Z no total"* — e o botão **"Novo Produto"** à direita. Abaixo, uma barra com **busca** (por nome ou SKU) e um seletor **Todos / Ativos / Inativos**, seguida de **chips de categoria** (Booster Box, Elite Trainer Box, Booster Pack, Blisters, Coleção Especial, Tin, Acessórios, Single Card). O corpo é uma **tabela** com uma linha por produto: miniatura + nome + SKU, categoria, preço (riscado quando há desconto), desconto, preço final, estoque (com selo **"baixo"** de 1 a 4 unidades e destaque para zerado), status, "Landing" (Sim/Não) e ações (editar / inativar-reativar). Criar ou editar abre uma **janela (modal)** com todos os campos e um cartão **"Preço final"** que recalcula ao vivo.

**🔑 Funcionalidades-chave.**
- Lista completa do catálogo (ativos e inativos), com busca e filtros combináveis por status e categoria.
- Resumo instantâneo no cabeçalho (ativos / inativos / total).
- Cálculo automático do preço final (preço base − desconto).
- Sinalização de estoque baixo e esgotado.
- Controle de destaque na página inicial ("Landing?") por produto.
- Upload de imagem com pré-visualização.
- Sugestão automática das medidas de embalagem para frete conforme a categoria.
- Inativar/reativar como forma segura de tirar/repor itens **sem apagar histórico**.

**⚙️ Ações possíveis.**
| Ação | O que acontece |
|------|----------------|
| **Criar produto** | Cadastra um item já ativo; gera o endereço único (URL) a partir do nome e recusa SKU repetido. |
| **Editar produto** | Altera qualquer campo; grava só o que mudou e registra o antes/depois na auditoria. |
| **Ajustar preço/desconto/estoque** | Preço em reais, desconto de 0 a 80%, estoque em unidades. O estoque **não pode** ficar abaixo do que já está reservado em pedidos pendentes. |
| **Marcar "Landing?"** | Coloca/tira o produto da vitrine "Em destaque" da home. |
| **Enviar/trocar imagem** | Sobe a foto para o repositório; ela só "cola" no produto quando o formulário é salvo. |
| **Inativar** | Tira o produto da loja mantendo histórico; exige marcar uma caixa de ciência. |
| **Reativar** | Devolve o produto à loja imediatamente. |

**🔄 Fluxo de trabalho (exemplo real).** Cadastrar um Booster Box em destaque: "Novo Produto" → preenche título/categoria/SKU → envia a foto → escreve a descrição → define preço R$ 599,90, desconto 10% (o "Preço final" já mostra R$ 539,91) e estoque 12 → marca "Landing?" → **Salvar**. Aparece *"Produto salvo."* e o item entra na lista como Ativo, aparecendo na vitrine. Para tirá-lo do ar depois, use **Inativar** (com a caixa de ciência) — ele some da loja mas continua no histórico e pode ser reativado a qualquer momento.

**📊 Indicadores disponíveis.** Total de ativos/inativos; preço, desconto e preço final por item; estoque atual com alertas; quantos produtos em destaque; quantos com desconto; distribuição por categoria (via filtros).

**🔔 Alertas e avisos.** Toasts *"Produto salvo."*, *"Produto inativado."*, *"Produto reativado."*; mensagens de erro amigáveis (SKU repetido, estoque abaixo do reservado, imagem grande/formato inválido); selo "baixo" e destaque de esgotado; *"Nenhum produto encontrado com esses filtros."*

**🛡️ Segurança integrada.** Acesso só de admin, **reconferido no servidor** a cada gravação; trilha de auditoria de toda criação/edição/inativação/reativação; proteção contra dois admins editarem o mesmo produto ao mesmo tempo (alterações em campos diferentes são preservadas); bloqueio de reduzir estoque abaixo do reservado; SKU único; validação de preço/desconto/descrição no servidor; upload restrito a imagens de verdade; produtos **nunca são apagados** (só inativados).

**🧯 Troubleshooting.**
| Se acontecer… | O que fazer |
|---------------|-------------|
| *"Já existe um produto com o SKU…"* | Use um SKU diferente (a busca aceita SKU para localizar o duplicado). |
| Não consigo reduzir o estoque | Há unidades reservadas em pedidos pendentes; o novo valor não pode ser menor que o reservado. |
| Botão Salvar desabilitado | Falta Título/SKU, preço ≤ 0, descrição > 300 caracteres, ou a imagem ainda está subindo. |
| Imagem recusada | Use PNG/JPG/WEBP/GIF de até 4 MB. |
| *"Envio de imagem não configurado"* | É configuração de ambiente do servidor; acione o responsável técnico. O cadastro pode ser salvo com a imagem padrão. |
| Um produto sumiu da loja | Provavelmente foi inativado — filtre por "Inativos" e reative. |
| Não acho como excluir de vez | Não existe por decisão de projeto (apagar quebraria o histórico). Use **Inativar**. |

**🔐 Permissões.** Somente admin. Modelo binário (admin/cliente), sem perfis intermediários. Todo admin pode executar todas as ações desta tela.

> **⚠️ Como funciona de verdade.**
> - **Não existe "excluir produto".** O mecanismo de remoção é o **Inativar** (o item sai da loja e o histórico é preservado).
> - O **upload de imagem** nesta versão (`main`) valida formato, tamanho (4 MB) e os **bytes reais do arquivo** (impede subir um arquivo disfarçado de imagem), mas **não tem limite de tentativas (rate limit)** e **não apaga a imagem antiga** ao trocá-la — arquivos substituídos ficam no repositório (ver [Lacunas](#6-módulo-segurança-e-operações)).
> - O **selo/badge** do produto (ex.: "Mais vendido") existe nos dados e aparece na loja, mas **não é editável** por este formulário.
> - A tabela mostra o **estoque físico**, não o "reservado" nem o "disponível" — o reservado só aparece na mensagem de erro ao tentar baixar o estoque abaixo dele.

---

### 3.2 Estoque baixo

**Rota:** `/admin/estoque`

**🎯 Objetivo.** Lista de vigilância que mostra, em tempo real, todos os produtos perto de acabar ou já esgotados, para o administrador saber o que precisa de reposição urgente.

**👤 Quem usa.** Administradores responsáveis por compras/reposição. Clientes não acessam.

**🖥️ Como é a tela.** Um relatório simples: título **"Estoque baixo"** e um resumo (*"7 produto(s) com estoque disponível baixo · 2 esgotado(s)"*). Uma tabela com 5 colunas — **Produto**, **Estoque** (quanto existe fisicamente), **Reservado** (preso em pedidos aguardando pagamento), **Disponível** (o que sobra para vender) e **Ações**. As linhas vêm ordenadas do **mais crítico ao menos crítico**; esgotados aparecem apagados. Quando não há risco: *"Tudo certo — nenhum produto com estoque baixo no momento."*

**🔑 Funcionalidades-chave.**
- Regra clara de alerta: lista todo produto cujo **disponível** (estoque − reservado) for **≤ 5 unidades**.
- Separa três números por produto: físico, reservado e disponível.
- Dados sempre ao vivo (refletem o momento exato da abertura).
- Fila de prioridade automática (menor disponível primeiro).
- Destaque visual do que já esgotou.

**⚙️ Ações possíveis.**
| Ação | O que acontece |
|------|----------------|
| **Consultar a lista** | Só leitura — abrir a tela nunca altera estoque nem reservas. |
| **Editar produto (lápis)** | Leva à tela de Produtos, onde o estoque é de fato ajustado. |

**🔄 Fluxo de trabalho.** O gerente abre "Estoque baixo", vê pelo resumo o tamanho do problema, olha o topo da lista (mais crítico), clica no lápis do item esgotado, vai para Produtos e cadastra a chegada de mercadoria (aumenta o estoque). O item sai da lista assim que o disponível ultrapassa 5.

**📊 Indicadores.** Nº de produtos com disponível baixo; nº de esgotados; por produto: físico, reservado, disponível; limite de alerta em uso (5).

**🔔 Alertas.** A tela **inteira é um alerta passivo** — é a "central de reposição". Não dispara e-mail nem push; o admin precisa entrar para ver.

**🛡️ Segurança integrada.** Área restrita a admin; em produção o painel é **fechado por padrão** se o login não estiver configurado; tela somente-leitura (evita alterações acidentais); o cálculo de "disponível" respeita uma regra do banco que garante que o reservado nunca ultrapassa o estoque (disponível nunca fica negativo).

**🧯 Troubleshooting.**
| Se acontecer… | O que fazer |
|---------------|-------------|
| Um item sumiu do relatório | O disponível dele subiu (reposição, ou um pedido pendente foi cancelado e devolveu unidades). |
| Estoque mostra 3, mas Disponível 0 | Correto: as 3 unidades estão **reservadas** em pedidos aguardando pagamento. Voltam ao disponível se o pedido for cancelado. |
| Cliquei no lápis e fui para outra tela | Esperado — o ajuste acontece na tela de Produtos. |
| Quero mudar o limite de 5 | Hoje é fixo no sistema; alterar exige ajuste técnico. |

**🔐 Permissões.** Somente admin; todos os admins têm o mesmo poder (consultar e navegar para editar).

> **⚠️ Como funciona de verdade.** Esta tela é **somente leitura** — a única ação é o link (lápis) que leva a Produtos. O limite de "estoque baixo" é **fixo em 5** (não configurável pela tela). A regra usa o **disponível**, não o estoque físico: um item com bastante estoque físico pode aparecer aqui se quase tudo estiver reservado.

---

### 3.3 Pedidos

**Rota:** `/admin/pedidos`

**🎯 Objetivo.** Tela de trabalho do pós-venda: ver de relance quem pagou, quem aguarda pagamento, o que enviar e o que foi cancelado; **despachar** pedidos (transportadora + rastreio); e, em exceção, **corrigir manualmente** o pagamento com justificativa.

**👤 Quem usa.** Administradores (conferência de pagamentos, expedição, suporte). Clientes não acessam.

**🖥️ Como é a tela.** Topo com **"Pedidos"** e o total. Uma faixa de **4 indicadores**: *Receita confirmada* (R$), *Aguardando pagamento*, *A enviar*, *Cancelados*. Barra com **busca** (cliente, e-mail ou nº do pedido) e filtro **Todos / Pago / Pendente / Cancelado**. Tabela com nº, cliente, itens, data, total, **etiqueta de Pagamento** (verde = Pago, vermelho = Cancelado, neutro = Pendente) e **etiqueta de Envio**, mais o botão **"Mudar status"**. Esse botão abre um modal com: seletor de **Pagamento** (com campo de **motivo** obrigatório quando alterado à mão), seletor de **Envio** (só os próximos passos válidos), **Transportadora**, **Código de rastreio** e **Nota interna** (visível só no admin).

**🔑 Funcionalidades-chave.**
- Visão única de pagamento e envio lado a lado, em etiquetas coloridas.
- Quatro indicadores calculados na hora.
- Busca e filtro por situação de pagamento.
- **Despacho**: registrar transportadora e rastreio (que vira link de rastreamento para o cliente).
- Envio por etapas: **A enviar → Enviado → Entregue** (sem pular etapas nem reabrir pedido entregue/cancelado).
- **Ajuste manual** de pagamento sempre com **motivo obrigatório**.
- **Nota interna** por pedido (não aparece para o cliente).

**⚙️ Ações possíveis.**
| Ação | O que acontece |
|------|----------------|
| **Buscar / filtrar** | Filtra a lista carregada por texto e por situação de pagamento. |
| **Mudar status de envio** | Avança a etapa ou cancela; cancelar repõe o estoque e, se ainda estava pendente, cancela o pagamento junto. |
| **Registrar rastreio** | Grava transportadora + código; o transportador só é salvo se houver código. |
| **Ajustar pagamento (com motivo)** | Muda a situação por decisão humana; reconcilia o estoque e grava o motivo na auditoria. |
| **Escrever nota interna** | Observação só para a equipe. |

**🔄 Fluxo de trabalho.** Cliente paga o PIX → o pedido vira **Pago sozinho** (Asaas avisa o sistema). O admin filtra por "Pago", olha "A enviar", abre o pedido, muda o Envio para **Enviado**, escolhe **Correios**, cola o rastreio e salva — o cliente passa a ver o rastreamento. Quando entregar, marca **Entregue**. *Exceção:* cliente pagou por comprovante fora do fluxo → admin muda o Pagamento para "Pago" e escreve o motivo obrigatório.

**📊 Indicadores.** Receita confirmada (soma dos pagos), aguardando pagamento, a enviar, cancelados, total de pedidos; por pedido: cliente, itens, data, total, situação de pagamento e envio.

**🔔 Alertas.** Toast *"Status atualizado."*; erros no modal (*"Transição de envio inválida"*, *"Ajuste manual… exige um motivo"*); *"Nenhum pedido encontrado com esses filtros."* **E-mail automático** de confirmação ao cliente quando o pagamento é confirmado pelo fluxo do Asaas.

**🛡️ Segurança integrada.** Permissão reconferida no servidor a cada ação; toda alteração na trilha de auditoria; correção manual de pagamento **exige justificativa** registrada; confirmação automática só aceita depois de conferir com o Asaas que a cobrança é daquele pedido e o valor bate; reenvio do mesmo aviso não duplica efeito; envio segue etapas fixas; estoque acertado sem duplicar; notas internas nunca aparecem para o cliente.

**🧯 Troubleshooting.**
| Se acontecer… | O que fazer |
|---------------|-------------|
| Botão Salvar desabilitado | Nada foi alterado no modal — mude algum campo. |
| *"Transição de envio inválida"* | O fluxo é por etapas (A enviar → Enviado → Entregue); avance uma de cada vez. |
| *"…exige um motivo"* | Toda mudança manual de pagamento pede um motivo (mín. 3 caracteres). |
| Pagamento não virou "Pago" sozinho | Aguarde a rede de conciliação (até ~10 min) ou use o ajuste manual se o cliente pagou por fora. |
| Transportadora não ficou salva | Preencha também o código de rastreio. |
| Pedido pendente virou Cancelado sozinho | PIX vencido é cancelado automaticamente (com estorno de estoque). Esperado. |

**🔐 Permissões.** Somente admin; qualquer admin faz todas as ações. Sem perfis intermediários.

> **⚠️ Como funciona de verdade.**
> - A **situação de pagamento muda sozinha** (Asaas + rotina de PIX vencido); o admin só intervém em exceção, com motivo. A **situação de envio é sempre manual**.
> - O **ajuste manual não valida a sequência** que o fluxo automático respeita. Consequência prática: marcar manualmente um pedido **já cancelado** como "Pago" muda o rótulo mas **não dá baixa no estoque**. **Oriente a equipe a não usar o ajuste manual para "ressuscitar" pedidos cancelados.**
> - Confirmar pagamento **manualmente não dispara** o e-mail ao cliente (só o fluxo automático dispara).
> - A tela carrega **todos os pedidos de uma vez** (busca/filtro/paginação no navegador). Funciona bem em volume pequeno/médio; tende a pesar conforme os pedidos crescem. Não há tela de detalhe do pedido, exportação nem ações em massa.

---

### 3.4 Cupons e promoções

**Rotas:** `/admin/cupons` (lista e gestão) · `/admin/cupons/[id]` (relatório de uso de um cupom)

**🎯 Objetivo.** Criar e gerenciar cupons de desconto (percentual ou valor fixo), definir regras (valor mínimo, limite total de resgates, limite por cliente, validade) e acompanhar, cupom a cupom, **quem usou, em qual pedido e quanto de desconto** foi concedido.

**👤 Quem usa.** Administradores; time de marketing/comercial (desde que tenha papel admin).

**🖥️ Como é a tela.** **Lista:** título "Cupons" com resumo (*"X ativos · Y inativos · Z no total"*) e **"Novo Cupom"**; busca por código e filtro Todos/Ativos/Inativos; tabela com **Código, Desconto** (−10% ou −R$ 20,00), **Mín. pedido, Usos** (usados/limite ou usados/∞), **Validade, Status** e ícones de ação (ver usos, editar, ativar/inativar, excluir). **Relatório (`/[id]`):** cabeçalho "Usos do cupom CÓDIGO", bloco-resumo e uma tabela de resgates — **Data, Pedido, Cliente, Total do pedido, Desconto aplicado**.

**🔑 Funcionalidades-chave.**
- Dois tipos de desconto: **percentual** (1–100%, inteiro) **ou** **valor fixo** em reais — nunca os dois.
- Regras opcionais: valor mínimo de compra (em produtos, sem frete), limite total de resgates, limite por cliente, janela de validade (início/expiração).
- Contador de usos que **sobe sozinho** conforme os pedidos reais usam o cupom (o admin não digita).
- Ativar/inativar sem apagar; **exclusão só para cupons nunca usados**.
- **Relatório de uso** por cupom (cada resgate com pedido, cliente e desconto).
- Código sempre em **MAIÚSCULAS** e único (ignora maiúsc./minúsc.).

**⚙️ Ações possíveis.**
| Ação | O que acontece |
|------|----------------|
| **Criar cupom** | Cadastra com todas as regras; valida no servidor; registra na auditoria. |
| **Editar cupom** | Altera regras; **não mexe** no contador de usos; grava antes/depois. |
| **Inativar / Reativar** | Liga/desliga o cupom sem apagá-lo. |
| **Excluir permanentemente** | Só se **nunca usado**; exige marcar caixa de confirmação. |
| **Ver usos** | Abre o relatório de resgates daquele cupom. |

**🔄 Fluxo de trabalho.** Campanha de boas-vindas: "Novo Cupom" → código `BEMVINDO10` → tipo Percentual, 10% → mín. R$ 50,00 → limite total 100, por usuário 1 → início hoje, expira em 30 dias → **Salvar**. O contador sobe a cada uso ("37 / 100"). Para ver o resultado, clique em **Ver usos**. Para encerrar antes do prazo, **inative** (o histórico é preservado). Cupom já usado **não pode** ser excluído (a lixeira fica desabilitada).

**📊 Indicadores.** Total e ativos/inativos; usos vs. limite por cupom; nº de resgates; desconto concedido por pedido (somável no relatório); vigência de cada campanha.

**🔔 Alertas.** Toasts de sucesso (*"Cupom salvo/inativado/reativado/excluído."*); erros (código repetido, percentual fora de 1–100, valor ≤ 0, expiração antes do início); botão excluir desabilitado em cupom usado (dica *"Cupom já utilizado — inative em vez de excluir"*); relatório vazio (*"Este cupom ainda não foi utilizado…"*).

**🛡️ Segurança integrada.** Acesso e cada ação reconferidos no servidor; todas as regras validadas no servidor (não só na tela); trilha de auditoria de tudo; **histórico financeiro protegido** (cupom usado nunca é apagado); contador **à prova de adulteração** (só cresce por pedidos reais); código único; valores em centavos; exclusão exige confirmação explícita.

**🧯 Troubleshooting.**
| Se acontecer… | O que fazer |
|---------------|-------------|
| Não consigo excluir (lixeira apagada) | O cupom já foi usado — por proteção do histórico, use **Inativar**. |
| *"Já existe um cupom com esse código."* | O código já está em uso (ignora maiúsc./minúsc.). Escolha outro. |
| Aparece "Ativo" mas não funciona no checkout | A etiqueta reflete só o liga/desliga. Verifique validade, valor mínimo e limites. |
| Percentual não aceita 7,5% | Percentual é inteiro (1–100). Para centavos, use "Valor fixo (R$)". |
| Contador de Usos não sobe | Só sobe quando o pedido efetivamente aplica o cupom no fechamento. Cheque o relatório. |

**🔐 Permissões.** Somente admin; todas as ações têm a mesma permissão. Relatório é leitura para todos os admins.

> **⚠️ Como funciona de verdade.** Não há dashboard agregado de cupons nem exportação — o "desconto total concedido" precisa ser somado da coluna do relatório. Só existem **dois tipos** (percentual/fixo): **não há "frete grátis" nem "brinde"** como tipo próprio. A etiqueta "Ativo" **não sinaliza "expirado"** visualmente. As datas são **só data** (sem hora). As proteções anti-fraude mais fortes (uso único por pedido, incremento atômico do limite, trava por cliente) atuam **no checkout**, não nesta tela — é o que torna o contador confiável.

---

### 3.5 Avaliações (moderação)

**Rota:** `/admin/avaliacoes`

**🎯 Objetivo.** Fila de moderação onde o admin decide, uma a uma, **quais avaliações de clientes serão publicadas** — garantindo que só conteúdo aprovado apareça na loja e conte na nota média do produto.

**👤 Quem usa.** Administradores / responsável por reputação e atendimento. Clientes só **enviam** avaliações; nunca moderam.

**🖥️ Como é a tela.** Título **"Avaliações"** com o total pendente (*"3 avaliações pendentes de moderação"*). Uma **lista de cartões** (da mais antiga para a mais recente), cada um com: estrelas (1–5), nome do autor, produto, data/hora, título e texto. No rodapé do cartão: **"Aprovar"** (verde) e **"Rejeitar"** (vermelho). Fila vazia: *"Nenhuma avaliação pendente."*

**🔑 Funcionalidades-chave.**
- Fila **só de pendentes**, por ordem de chegada.
- Contador de pendentes no cabeçalho.
- Contexto completo por cartão para decidir.
- Duas decisões: **Aprovar** (publica) ou **Rejeitar** (descarta), com efeito imediato.
- Só aprovadas aparecem na loja e contam na nota média.
- **Recálculo automático** da nota média e da contagem do produto a cada decisão.
- Regra de **uma avaliação por cliente por produto** (garantida no envio).

**⚙️ Ações possíveis.**
| Ação | O que acontece |
|------|----------------|
| **Aprovar** | A avaliação passa a aparecer na página do produto e entra na nota média/contagem. Reflete na loja em até ~60 s. |
| **Rejeitar** | Nunca será exibida e não conta na nota. O conteúdo **não é apagado** (fica registrado como rejeitado). |

**🔄 Fluxo de trabalho.** Um cliente deixa 5 estrelas com o comentário "Carta impecável". A avaliação nasce **pendente** e não aparece na loja. O admin abre a tela, lê o cartão e clica em **Aprovar** — o card some, surge *"Avaliação aprovada."*, e a nota média do produto é recalculada. Se fosse spam/ofensivo, clicaria em **Rejeitar**.

**📊 Indicadores.** Nº de pendentes (tamanho da fila); por avaliação: nota, produto, autor, data. Alimenta (fora desta tela) a nota média e o total de avaliações aprovadas do produto.

**🔔 Alertas.** Contador no cabeçalho; toasts *"Avaliação aprovada/rejeitada."*; *"Avaliação não encontrada."* (já tratada por outra pessoa/aba); *"Acesso negado."*; fila vazia.

**🛡️ Segurança integrada.** Permissão reconferida a cada ação; trilha de auditoria de toda decisão; operação **tudo-ou-nada** (status + recálculo + auditoria juntos); proteção contra cliques repetidos e moderação simultânea (não duplica votos nem corrompe a nota); **muralha de publicação** (nada vai ao ar sem aprovação); validação do conteúdo na origem (nota 1–5, tamanhos, anti-repetição).

**🧯 Troubleshooting.**
| Se acontecer… | O que fazer |
|---------------|-------------|
| Aprovei mas não aparece no produto | Propaga quase em tempo real na página do produto e em até ~60 s no catálogo. Recarregue. |
| *"Avaliação não encontrada."* | Já foi moderada em outra aba/pessoa. Nada indevido ocorreu; recarregue. |
| Preciso reverter uma decisão | A tela só mostra pendentes; reverter exige ajuste da equipe técnica (o conteúdo não é apagado). |
| Fila vazia, esperava ver as já tratadas | Esperado — a tela lista só pendentes. |

**🔐 Permissões.** Somente admin; clientes apenas enviam. Sem papel intermediário de "moderador".

> **⚠️ Como funciona de verdade.** A tela mostra **exclusivamente pendentes** — não há aba/busca para aprovadas/rejeitadas, nem ação em lote, nem resposta ao cliente. Depois de moderada, **não há como revisitar/reverter pela interface**. Rejeitar é "moderação suave": **não apaga** o conteúdo, só o torna invisível.

---

## 4. Módulo FINANCEIRO

> **Visão geral:** o dinheiro entra por **PIX**, processado pelo **Asaas**. O grande diferencial é que **quase tudo é automático**: o cliente paga, o pedido vira "Pago", o estoque baixa e o cliente recebe e-mail — sem intervenção. Uma **rede de segurança** cuida dos casos que escapam (aviso perdido, PIX vencido, cobrança duplicada). Não há uma tela de "Pagamentos": o controle vive na tela de **Pedidos**, e a conciliação roda nos bastidores.

---

### 4.1 Pagamentos e conciliação (Asaas / PIX)

**🎯 Objetivo.** Receber com segurança e manter pedido, pagamento e estoque sempre coerentes — de forma automática.

**🔄 O caminho do dinheiro.**

```
  CLIENTE                    RM CARDS (servidor)                 ASAAS
  ───────                    ───────────────────                 ─────
  Finaliza compra  ─────────▶ Recalcula preços/frete/cupom
                              (fonte da verdade = servidor)
                              Cria pedido "PENDENTE"
                              + RESERVA estoque   (tudo-ou-nada)
                                     │
                                     ├──── cria cobrança PIX ────▶ gera cobrança
                                     │◀─── QR Code + copia-e-cola ─┘
  Recebe o QR  ◀────────────────────┘
      │
  Paga o PIX  ──────────────────────────────────────────────────▶ recebe R$
                              confirma pedido  ◀── "PAGO" (webhook) ─┘
                              • status → PAGO
                              • BAIXA definitiva de estoque
                              • e-mail de confirmação
  Recebe e-mail ◀─────────────┘
```

1. **Recalcula tudo no servidor.** Preço, desconto, cupom e frete vêm do banco — o site **nunca confia no valor enviado pela tela do cliente**. O cliente só escolhe *o que* comprar, nunca *quanto custa*.
2. **Cria o pedido "Pendente" e reserva o estoque** na mesma operação (se faltar estoque, o pedido é desfeito).
3. **Gera a cobrança PIX** com vencimento em **3 dias** e guarda o vínculo com a cobrança.
4. **Entrega o QR Code** ao cliente.
5. **Cliente paga.** O Asaas avisa o sistema (webhook).
6. **O sistema confirma sozinho:** status → Pago, baixa de estoque, e-mail de confirmação.

**🧷 A rede de segurança (tudo automático).**
- **Conciliação (a cada ~10 min):** se o aviso do Asaas se perder, um robô pergunta ativamente ao Asaas se pedidos pendentes antigos (30+ min) já foram pagos, e confirma o que ficou para trás. **Nenhum pagamento recebido fica sem virar "Pago".** Só mexe em pendentes — nunca cancela algo pago.
- **Estoque nunca some nem duplica:** ciclo *reserva → baixa → estorno/reposição*, com "carimbos" que garantem que só a **primeira** operação mexe no estoque. Mesmo que o Asaas mande o aviso 10 vezes, baixa **uma vez**.
- **Cobrança nunca duplica:** clicar "finalizar" duas vezes reaproveita o mesmo pedido; e a criação de cobrança **nunca é repetida automaticamente**.
- **PIX vencido (não pago em 3 dias):** um robô cancela o pedido e **devolve a reserva** ao estoque — com uma **janela de tolerância de 60 min** para não cancelar por engano um pagamento que chegou em cima do vencimento.

**🛡️ Garantias contra fraude e evento repetido.**
- **Valor sempre do servidor** + conferência do valor pago contra o total (tolerância de 1 centavo). Não bateu → recusado.
- **Anti-replay:** o evento só é aceito se a cobrança for exatamente a daquele pedido; eventos repetidos são reconhecidos e ignorados; o aviso do Asaas exige um **token secreto**.
- **Tudo-ou-nada:** registrar o evento, aplicar o efeito e marcar como processado acontecem juntos.

**📊 Indicadores.** Ver [Relatórios de receita](#42-relatórios-de-receita-e-indicadores).

**🧯 Troubleshooting.**
| Se acontecer… | O que fazer |
|---------------|-------------|
| Pedido preso em "Pendente" | Normal nos primeiros minutos. A conciliação confirma em até ~10 min se houve pagamento. Se ficar horas, o cliente provavelmente não pagou — o PIX será cancelado após o vencimento. |
| Pago no Asaas, mas o pedido não atualizou | Aguarde um ciclo de conciliação (~10 min). Se persistir, é configuração de ambiente (tokens/segredos). Último recurso: **ajuste manual** na tela de Pedidos, com motivo. |
| PIX expirado | Tratado sozinho: pedido "Cancelado" e estoque devolvido. |
| Preciso **devolver dinheiro** | Não há botão de estorno no admin — estornos nascem no Asaas e chegam por aviso (viram "Cancelado" e repõem o estoque). |

> **⚠️ Como funciona de verdade.** **Não existe tela de pagamentos.** O único controle humano é o **ajuste manual** de exceção dentro do modal de Pedidos (com motivo obrigatório e auditado). O ajuste manual para "Cancelado" repõe estoque, mas **não movimenta dinheiro** no Asaas — é só acerto interno. **Caso de borda:** se no checkout a cobrança foi criada mas o vínculo com o pedido falhou ao gravar, nem o webhook nem a conciliação conseguem confirmar aquele pedido — nesse caso, use o ajuste manual.

---

### 4.2 Relatórios de receita e indicadores

**🎯 Objetivo.** Dar leitura financeira do negócio a partir dos dados de pedidos.

**📊 Indicadores já exibidos** (topo da tela de Pedidos):
- **Receita confirmada** — soma do total dos pedidos **Pagos**.
- **Aguardando pagamento** — nº de pedidos Pendentes.
- **A enviar** — pedidos Pagos ainda não despachados (fila de expedição).
- **Cancelados** — nº de pedidos Cancelados.

**📈 Indicadores deriváveis** dos mesmos dados (não exibidos hoje, mas calculáveis):
- **Ticket médio** = Receita confirmada ÷ nº de pedidos pagos.
- **Taxa de conversão** = Pagos ÷ (Pagos + Pendentes + Cancelados).
- **Abandono de PIX** = Cancelados ÷ total (proxy de PIX gerado e não pago).
- **Frete arrecadado**, **desconto de cupom concedido**, **desconto de produto** — soma dos respectivos campos nos pedidos pagos.
- **Receita por período** — filtrando pela data do pedido.

> **⚠️ Como funciona de verdade.** Os indicadores da tela são calculados sobre **todos os pedidos** (histórico completo), **não** por intervalo de datas, e **não há gráficos de tendência** nem relatório financeiro com filtro de período. Uma evolução natural do produto seria uma tela de relatórios com recorte por data e exportação.

---

## 5. Módulo CLIENTES

> **Visão geral:** reúne a base de pessoas e o controle de **quem entra no painel**. A lista de usuários é um **espelho automático** do sistema de login: quem cria conta, atualiza dados ou é removido aparece/atualiza aqui sozinho. O ponto de controle da equipe é simples e poderoso: **promover ou rebaixar** entre Cliente e Admin.

---

### 5.1 Gestão de usuários

**Rota:** `/admin/usuarios`

**🎯 Objetivo.** Ver todas as pessoas cadastradas e controlar **quem tem acesso de administrador**, alternando cada uma entre **Cliente** e **Admin**.

**👤 Quem usa.** Administradores (normalmente o dono/gerente). Clientes não acessam.

**🖥️ Como é a tela.** Título **"Usuários"** com resumo (*"X admins · Y no total"*). **Busca** por e-mail ou nome. Tabela com **E-mail, Nome, Criado em** e **Função**. Na coluna Função, um par de botões **"Cliente"** e **"Admin"** funciona como chave — o papel atual fica **verde**. Na linha do próprio admin logado aparece a etiqueta **"Você"** e os botões ficam **travados** (dica: *"Você não pode alterar a própria função."*).

**🔑 Funcionalidades-chave.**
- Lista de todos os usuários ativos (mais recentes primeiro).
- Contador de admins e total no topo.
- Busca instantânea por e-mail ou nome.
- Chave de função por usuário (Cliente ↔ Admin).
- **Proteção anti-bloqueio**: o admin não pode alterar a própria função.
- Espelho automático do sistema de login.

**⚙️ Ações possíveis.**
| Ação | O que acontece |
|------|----------------|
| **Promover a Admin** | Concede acesso ao painel; registra na auditoria (quem, quando, antes/depois). |
| **Rebaixar a Cliente** | Remove o acesso administrativo; também registrado. |
| **Buscar / limpar** | Filtra a lista por e-mail ou nome. |
| **Alterar a própria função** | **Bloqueado** — proteção contra se trancar para fora. |

**🔄 Fluxo de trabalho.** Dar acesso a um novo funcionário: ele **cria conta** na loja → o gerente vai em Usuários, busca o e-mail, clica em **"Admin"** (fica verde) → surge *"Usuário promovido a admin."* e ele já entra no painel. Para revogar, clica em **"Cliente"**.

**📊 Indicadores.** Total de usuários ativos; nº de admins; nº de clientes (derivável); data de cadastro por conta.

**🔔 Alertas.** Toasts *"Usuário promovido a admin."* / *"…rebaixado a cliente."*; erros (*"Você não pode alterar a própria role."*, *"Usuário não encontrado."*, *"Acesso negado."*); *"Nenhum usuário encontrado."*

**🛡️ Segurança integrada.** Trilha de auditoria de toda promoção/rebaixamento; **proteção anti-bloqueio** (na tela e no servidor); dupla verificação de permissão; usuários removidos ficam **ocultos, não apagados** (histórico preservado); a lista chega por um canal **assinado e verificado**, com proteção contra processar o mesmo evento duas vezes.

**🧯 Troubleshooting.**
| Se acontecer… | O que fazer |
|---------------|-------------|
| Conta nova não aparece | A lista vem do login via sincronização; se estiver mal configurada, contas novas não chegam. Contorno: e-mails em `ADMIN_EMAILS` já entram como admin no próximo acesso. |
| Rebaixei alguém e voltou a Admin sozinho | O e-mail dela está em `ADMIN_EMAILS` (repromove a cada sincronização). Para rebaixar de vez, remova o e-mail dessa configuração (feito por quem administra o ambiente). |
| Botões da minha linha travados | Intencional (proteção anti-bloqueio). Peça a outro admin. |
| Quero convidar/cadastrar usuário por aqui | Não é possível — a conta nasce quando a pessoa se registra na loja; depois ela aparece aqui. |

**🔐 Permissões.** Somente admin. Acesso concedido (1) por esta tela ou (2) automaticamente por `ADMIN_EMAILS`. Um admin promove/rebaixa qualquer outro, **nunca a si mesmo**.

> **⚠️ Como funciona de verdade.** Esta tela **não cria, convida nem exclui** usuários — só **lista e troca o papel**. A "exclusão" é um ocultamento disparado pelo sistema de login (preserva histórico). O **ícone de lixeira** que aparece é apenas o **"Limpar" da busca** — não apaga usuário.

---

### 5.2 Permissões de acesso

O RM Cards usa um modelo **binário e proposital**:

| Papel | O que pode fazer |
|-------|------------------|
| **Administrador** | Acesso total ao painel: catálogo, estoque, pedidos, cupons, avaliações e usuários. |
| **Cliente** | Usa a loja, compra, acompanha as próprias compras e envia avaliações. **Nenhum** acesso ao painel. |

**Como a proteção funciona (em duas camadas):**
1. **Na entrada:** o painel inteiro é bloqueado para quem não é admin (redirecionado para a loja).
2. **Em cada ação:** toda operação de gravação **reconfere o papel no servidor** — mesmo que alguém tente burlar a interface, é recusado.

> **⚠️ Como funciona de verdade.** Não existem perfis intermediários (**Vendedor / Operador / Visualizador**). Se o negócio precisar deles no futuro (ex.: um operador que só despacha pedidos, sem mexer em preços), isso é uma **evolução de produto** a planejar. A [Matriz de permissões](#b-matriz-de-permissões-por-papel) mostra o mapeamento real.

---

### 5.3 Histórico de compras

O histórico de cada cliente **existe**, mas fica na **área do próprio cliente** na loja (*"Minhas compras"* — `/painel`), não em uma tela de admin. Lá o cliente vê seus pedidos, status e rastreamento.

No painel administrativo, o histórico é acessível **por pedido**, pela tela de [Pedidos](#33-pedidos) (buscando por nome/e-mail do cliente). Uma **ficha consolidada do cliente** (todas as compras de uma pessoa em uma tela) **não existe hoje** — é uma evolução natural.

> **🛡️ Nota de privacidade:** cada cliente só enxerga os **próprios** pedidos — a busca é sempre filtrada pela identidade confirmada de quem está logado. (Isto corrigiu uma falha histórica registrada na auditoria interna do projeto.)

---

## 6. Módulo SEGURANÇA E OPERAÇÕES

> **Visão geral:** a segurança não é uma tela — é uma **camada que atravessa todo o painel**. Abaixo, em linguagem de negócio, o que o sistema faz para proteger dados, dinheiro e a operação, além de uma seção **honesta de lacunas**.

### 6.1 Como protegemos os dados dos clientes
- **Ninguém entra sem login.** Áreas sensíveis (painel, "minhas compras", checkout) exigem autenticação antes de a página carregar.
- **Ser admin é verificado duas vezes, sempre no servidor** — não basta o painel esconder botões.
- **Cada cliente só vê os próprios dados.**
- **Contas e senhas ficam com um provedor especializado (Clerk).** A loja **nunca guarda senha**; a sincronização usa mensagens **assinadas digitalmente**.
- **Proteções de navegador ligadas para todos:** HTTPS obrigatório, anti-clickjacking, bloqueio de câmera/microfone/localização, e o endereço das páginas não vaza para sites externos. Erros nunca expõem detalhes internos.

### 6.2 Como protegemos os pagamentos
- **O valor é sempre decidido pelo servidor**, em centavos (sem erro de arredondamento).
- **As confirmações vêm por um canal autenticado** (token secreto conferido de forma segura).
- **Anti-fraude:** o pedido só vira "Pago" se o aviso for da cobrança **daquele** pedido e o **valor bater**. Pedido cancelado nunca "ressuscita".
- **Aviso repetido não cobra nem processa duas vezes.**
- **Rede de conciliação** recupera pagamentos "perdidos", mexendo só em pendentes.

### 6.3 Como rastreamos quem fez o quê (trilha de auditoria)
- **Toda alteração de admin deixa um registro imutável** — quem, o quê, quando e o **antes e depois** completo.
- **Registro e alteração são inseparáveis** (mesma transação): nunca sobra rastro sem efeito nem efeito sem rastro.
- **Dá para reconstruir a história** por entidade, por data e por autor. Até efeitos automáticos (baixa de estoque por pagamento) ficam registrados, com autoria "sistema".

### 6.4 Defesa contra abuso e ataques
- **Freio contra spam/força-bruta (rate limiting)** em ações de negócio: checkout, pré-visualização de cupom, cotação de frete, recuperação de PIX e envio de avaliação têm teto de tentativas por minuto (por usuário ou por IP). Em produção o contador é **compartilhado**, então o limite vale para o sistema todo. Se o banco cair, o freio "abre" de propósito (para nunca derrubar uma compra).
- **Upload de imagem à prova de disfarce:** aceita só imagens de verdade — o sistema inspeciona os **bytes reais** do arquivo, ignorando o tipo declarado pelo navegador. Nome do arquivo é gerado pelo servidor.
- **Cabeçalhos de segurança** e **proteção contra injeção de SQL** (todo acesso ao banco é parametrizado).

### 6.5 Compliance (LGPD e PCI-DSS) em linguagem simples
- **PCI-DSS (dados de cartão):** *a loja não toca em dados de cartão.* O pagamento é PIX pelo **Asaas** (certificado); só trafegam o identificador da cobrança e o QR. Isso **reduz drasticamente** o escopo de PCI do lojista.
- **LGPD (dados pessoais):** contas/senhas no provedor especializado; **trilha de auditoria** de acessos/alterações; cada cliente vê só os próprios dados; exclusão preserva histórico sem quebrar pedidos; HTTPS obrigatório; cabeçalhos de privacidade.
- **Continua por conta do lojista** (operação/política, não código): configurar chaves/segredos no deploy; publicar aviso de privacidade e definir base legal; atender pedidos de titulares; definir **prazo de retenção/expurgo** dos registros; assinar contratos/DPAs com os fornecedores (Clerk, Asaas, Supabase, Vercel, SuperFrete).

### 6.6 Configuração e operação (o que o ambiente exige)
Vários mecanismos dependem de **chaves e segredos configurados no deploy**. Sem eles, o comportamento seguro é "fechado por padrão":
- **Login (Clerk):** sem as chaves, o painel `/admin` fica **fechado** em produção.
- **Webhook Asaas:** sem o token, confirmações automáticas são recusadas.
- **Conciliação:** sem o segredo próprio, o robô de conciliação não roda.
- **Storage de imagens:** sem a chave, o upload de imagem fica indisponível (o resto do cadastro funciona).

### 6.7 Lacunas e ressalvas (transparência)
> Itens abaixo **não** estão implementados nesta versão (`main`) — são pontos de atenção/roadmap, não defeitos ocultos.
- **Upload de imagem sem rate limiting.** Um admin autenticado poderia enviar muitos arquivos em sequência sem freio dedicado.
- **Imagens órfãs se acumulam.** Trocar a imagem de um produto deixa o arquivo antigo no repositório; não há limpeza automática.
- **O login em si não usa o nosso rate limiting** — a defesa contra força-bruta na autenticação fica a cargo do Clerk (que tem proteção própria + anti-bot).
- **A política de conteúdo (CSP) completa está em "modo observação"** — reporta violações, mas ainda não bloqueia scripts inline; a promoção para "modo bloqueio" é um passo manual.
- **O freio compartilhado só liga em produção.** Em ambientes de teste, cai num contador mais fraco.
- **Controle de acesso é 100% na camada da aplicação**, não no banco (o repositório de imagens é **público** por design). Se os guards da aplicação falharem, não há uma segunda barreira no banco.

---

## 7. Fluxos de trabalho de ponta a ponta

### 7.1 Do produto criado à venda finalizada
```
[Admin: Produtos]           [Loja]              [Cliente]            [Sistema]
      │                        │                    │                   │
 cria produto ──────────────▶ aparece no ──────▶ adiciona ao          │
 (ativo, com estoque)         catálogo            carrinho             │
                                                     │                 │
                                              finaliza compra ───────▶ recalcula preço/frete/cupom
                                                     │                 cria pedido PENDENTE + reserva estoque
                                                     │◀── QR PIX ───────┤
                                                 paga o PIX ──────────▶ confirma sozinho:
                                                     │                 PAGO + baixa estoque + e-mail
[Admin: Pedidos]                                     │                   │
 filtra "Pago" / "A enviar" ◀────────────────────────┼───────────────────┘
      │                                              │
 despacha (transportadora + rastreio) ─────────────▶ cliente acompanha rastreamento
      │
 marca "Entregue"  ✔ venda concluída
```

### 7.2 Ciclo de vida do pagamento e do estoque
```
PAGAMENTO:   pending ──(PIX pago / ajuste manual)──▶ paid
                 └────(PIX vencido / estorno)──────▶ cancelled
             (paid e cancelled são finais: não voltam sozinhos)

ESTOQUE:     checkout ─▶ RESERVA ─▶ (pagou) BAIXA
                            └────▶ (cancelou/expirou) ESTORNA ─▶ volta a ser vendável
```

### 7.3 Moderação de uma avaliação
```
cliente compra ─▶ escreve avaliação ─▶ status PENDENTE (não aparece na loja)
                                              │
                              [Admin: Avaliações]
                                   ├─ Aprovar ─▶ aparece na loja + entra na nota média
                                   └─ Rejeitar ─▶ nunca aparece (conteúdo guardado, não apagado)
```

---

## 8. Apêndices

### A. Glossário (termo técnico → linguagem simples)

| Termo | O que significa no dia a dia |
|-------|------------------------------|
| **Admin / Cliente** | Os dois únicos tipos de acesso. Admin usa o painel; cliente usa a loja. |
| **SKU** | Código único de um produto (para não confundir itens parecidos). |
| **Landing** | Se o produto aparece na vitrine "Em destaque" da página inicial. |
| **Inativar** | Tirar um produto/cupom da loja **sem apagar** o histórico. |
| **Estoque físico / Reservado / Disponível** | O que existe / o que está preso em pedidos pendentes / o que dá para vender agora (físico − reservado). |
| **PIX / Asaas** | Forma de pagamento / empresa certificada que processa o PIX. |
| **Webhook** | O "aviso automático" que o Asaas manda para a loja quando um pagamento acontece. |
| **Conciliação** | Robô que confere pagamentos pendentes com o Asaas e acerta o que ficou para trás. |
| **Trilha de auditoria** | Registro permanente de quem fez o quê (quem, quando, antes/depois). |
| **Rate limiting** | Freio que limita quantas vezes por minuto uma ação pode ser feita (anti-spam/abuso). |
| **Idempotência** | Garantia de que repetir a mesma operação não gera efeito duplicado (ex.: não cobrar duas vezes). |
| **CSP / HTTPS / clickjacking** | Proteções técnicas do navegador contra sites maliciosos e roubo de dados. |
| **Soft-delete** | "Exclusão suave" — o registro fica oculto em vez de apagado, para preservar histórico. |
| **Mock-first** | Modo de desenvolvimento em que o sistema funciona sem os serviços externos configurados. |

### B. Matriz de permissões por papel

> O sistema **real** tem só dois papéis. A tabela inclui, em cinza, os papéis que o *brief* imaginou (**Vendedor / Operador / Visualizador**) — **não implementados** — para deixar claro o mapeamento.

| Ação | Administrador | Cliente | *Vendedor* | *Operador* | *Visualizador* |
|------|:---:|:---:|:---:|:---:|:---:|
| Acessar o painel `/admin` | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Cadastrar/editar produtos | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Inativar/reativar produtos | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Ver estoque baixo | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Despachar pedidos / rastreio | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Ajuste manual de pagamento | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Criar/gerenciar cupons | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Moderar avaliações | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Promover/rebaixar usuários | ✅ | ❌ | *n/d* | *n/d* | *n/d* |
| Comprar na loja | ✅¹ | ✅ | — | — | — |
| Acompanhar as próprias compras | ✅¹ | ✅ | — | — | — |
| Enviar avaliação | ✅¹ | ✅ | — | — | — |

<sub>✅ = permitido · ❌ = bloqueado · *n/d* = papel não existe no sistema. ¹ Um admin também é uma pessoa e pode comprar como cliente.</sub>

**Regra de ouro:** quem é **admin pode tudo** no painel; quem é **cliente não vê nada** do painel. Não há meio-termo.

### C. Checklist de setup inicial

**Ambiente / técnico (feito por quem administra o deploy):**
- [ ] Configurar o **login (Clerk)** — sem isso, o painel fica fechado em produção.
- [ ] Definir `ADMIN_EMAILS` com o(s) e-mail(s) do(s) primeiro(s) administrador(es).
- [ ] Configurar o **token do webhook Asaas** (confirmações automáticas).
- [ ] Configurar o **segredo da conciliação** e o agendamento (robôs de PIX/conciliação).
- [ ] Configurar a **chave do Storage** (upload de imagens).
- [ ] Confirmar **HTTPS** e cabeçalhos de segurança ativos.

**Operação / negócio (feito pela equipe da loja):**
- [ ] Fazer o **primeiro login** e confirmar acesso ao painel.
- [ ] Promover os demais administradores em **Usuários**.
- [ ] Cadastrar as **categorias e primeiros produtos** (com imagem e medidas de frete).
- [ ] Marcar os produtos de **destaque** ("Landing?").
- [ ] Criar os **cupons** das campanhas iniciais.
- [ ] Fazer um **pedido de teste** ponta a ponta (pagar um PIX de valor baixo) e confirmar a virada automática para "Pago".
- [ ] Definir a **política de moderação** de avaliações e o responsável.
- [ ] Definir o **prazo de retenção** de dados/registros (LGPD) e publicar o aviso de privacidade.

### D. Indicadores (KPIs) por tela

| Tela | Indicadores disponíveis |
|------|--------------------------|
| **Produtos** | Ativos / inativos / total; preço, desconto e preço final; estoque com alertas; em destaque; por categoria. |
| **Estoque baixo** | Nº com disponível baixo; nº esgotados; físico/reservado/disponível por item. |
| **Pedidos** | **Receita confirmada**, aguardando pagamento, a enviar, cancelados, total. Deriváveis: ticket médio, conversão, abandono de PIX, frete/desconto arrecadados. |
| **Cupons** | Total e ativos/inativos; usos vs. limite; nº de resgates; desconto por pedido; vigência. |
| **Avaliações** | Nº de pendentes; (alimenta) nota média e total de avaliações do produto. |
| **Usuários** | Total de usuários; nº de admins; nº de clientes; data de cadastro. |

> Lembrete: **não há uma tela única de dashboard** — os indicadores vivem dentro de cada tela.

### E. Notas de realidade (consolidadas)

Pontos onde a expectativa comum diverge do sistema **real**, reunidos para gestão de expectativas:
- **Papéis:** só **Admin** e **Cliente** (sem Vendedor/Operador/Visualizador).
- **Dashboard:** não existe tela de KPIs gerais; `/admin` abre em Produtos.
- **Telas que o brief supôs e não existem como tela dedicada:** Pagamentos, Configurações, Relatórios, Auditoria. (Pagamentos é automático; auditoria existe como registro, não como tela.)
- **Excluir produto:** não existe (usa-se Inativar).
- **Upload de imagem (`main`):** valida bytes reais, formato e tamanho, mas **sem rate limit** e **sem limpeza de imagens órfãs**.
- **Ajuste manual de pagamento:** não valida a sequência de estados — não usar para "ressuscitar" pedidos cancelados.
- **Escala das listas:** Pedidos e Usuários carregam tudo de uma vez (busca/filtro no navegador) — ótimo para volume pequeno/médio.
- **CSP:** em "modo observação" (ainda não bloqueia).

### F. Contatos e suporte

| Assunto | Responsável | Observação |
|---------|-------------|------------|
| Acesso ao painel / promover admin | Administrador da loja | Tela **Usuários**; primeiro acesso via `ADMIN_EMAILS`. |
| Configuração de ambiente / segredos | Responsável técnico (deploy) | Chaves de Clerk, Asaas, Storage, conciliação. |
| Pagamento não conciliado / estorno | Financeiro + suporte Asaas | Ver [Troubleshooting de pagamentos](#41-pagamentos-e-conciliação-asaas--pix). |
| Frete / rastreio | Operação + SuperFrete | Transportadora e código na tela de Pedidos. |
| Dúvidas de LGPD / privacidade | Responsável de dados (DPO) | Política de retenção e atendimento a titulares. |

*(Preencher com nomes/e-mails reais da equipe RM Cards.)*

---

### Sobre este documento

- **Formato:** Markdown estruturado — pronto para GitHub/GitBook, para exportar como **PDF** (imprimir a versão HTML que acompanha) ou para colar no **Notion/Google Docs**.
- **Fonte:** mapeado do código real (branch `main`, Julho/2026). As **notas "⚠️ Como funciona de verdade"** registram divergências entre suposições e o sistema construído.
- **Manutenção:** ao evoluir o produto (novos papéis, tela de relatórios, limpeza de imagens), atualize as seções e as notas de realidade correspondentes.

*Documentação executiva RM Cards — sem jargão, focada em operação e segurança, pronta para treinamento da equipe.*

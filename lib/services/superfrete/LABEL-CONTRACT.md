# CONTRATO CONGELADO — etiqueta SuperFrete (SYNC 0, 2026-07-01)

Interface TS: `lib/services/superfrete/label-types.ts` (congelada; mudanças só com
reconciliação A↔B). Fontes: plugin WordPress oficial da SuperFrete (código) +
sondas REAIS no sandbox com o token local. Shapes marcados **[capturado]** vêm de
resposta real; **[plugin]** vêm do código oficial; **[gate]** = confirmar no portão.

## Autenticação (reuso do projeto)

Toda chamada via `superFreteRequest` (lib/services/superfrete/client.ts): Bearer
token + User-Agent obrigatório + JSON + timeout 12s + log estruturado sem token.
`retry: true` SÓ em chamadas idempotentes (GETs). **cart/checkout NUNCA re-tentam
no HTTP** (têm efeito colateral; a idempotência é por externalRef, camada acima).

## Mapeamento provedor ⇄ contrato

### 1) Criar envio — `POST /api/v0/cart` **[capturado]**

Request (unidades do provedor: kg/cm/reais; strings em products conforme plugin):

```json
{
  "from": { "name", "document", "address", "number", "complement"?, "district", "city", "state_abbr", "postal_code" },
  "to":   { "name", "document(OBRIGATÓRIO)", "address", "number", "complement"?, "district", "city", "state_abbr", "postal_code", "email"?, "phone"? },
  "service": 1,
  "products": [ { "name": "Carta X", "quantity": "1", "unitary_value": "30.00" } ],
  "volumes": { "height": 2, "width": 11, "length": 16, "weight": 0.05 },
  "options": {
    "insurance_value": 30,
    "receipt": false,
    "own_hand": false,
    "non_commercial": true,
    "tags": [ { "tag": "<externalRef>" } ]
  },
  "platform": "RM Cards"
}
```

Response 200 **[capturado]**:
`{"id":"ZMWwpuoswkgXkwN0uKWz","price":18.78,"protocol":"ZMWwpuoswkgXkwN0uKWz","self_tracking":"","status":"pending","tags":[{"tag":"rmcards-sync0-probe-1"}]}`

Erro 400 **[capturado]**: `{"errors":{"to.document":["Campo CPF/CNPJ do destinatário é obrigatório..."]},"message":"Ocorreu um ou mais erros."}` — mapa `errors` por campo.

### 2) Pagar/emitir — `POST /api/v0/checkout` **[gate: 409 CAPTURADO]**

Request: `{"orders":["<superFreteId>"]}`. **RECONCILIAÇÃO DO PORTÃO
(2026-07-01):** o 409 é um conflict GENÉRICO — capturado
`409 {"message":"Sem saldo na carteira! Utilize o app para recarregar...","error":...}`
com saldo 0. Ou seja, **409 ≠ "já pago" às cegas** (a hipótese herdada do plugin
oficial era incompleta): classifique pela MENSAGEM (saldo ⇒
`insufficient_balance`; "já pago/paid" ⇒ sucesso idempotente) e, no ambíguo,
**verifique por leitura** no `order/info` (status pago ⇒ sucesso; senão propaga).
Consome SALDO da carteira — a "franquia" `limits.shipments_available` **NÃO paga
etiqueta** (confirmado: saldo 0 + shipments_available 5 ⇒ 409 de saldo; o
contador até SUBIU de 5 p/ 10 após cancelamentos — semântica desconhecida,
tratar como observabilidade, nunca como cobertura).

### 3) Imprimir — `POST /api/v0/tag/print` **[plugin]** → `{"url": "..."}`

A URL de impressão carrega `?format=A4` **[capturado em order/info.print.url]**;
formatos A4 (padrão) e A6/térmica. Parâmetro de formato no body (`{"orders":[id],
"format":"A6"}`?) **[gate]** — fallback: reescrever o query param da URL.

**[gate]** Dimensões: na emissão o provedor pode NORMALIZAR o pacote PARA CIMA
(capturado: 13×9×2 → 15×10×2; 16×12×10 → 24×16×10) — o `order/info` devolve as
dimensões finais da embalagem, não o eco do input; peso é preservado.

### 4) Consultar — `GET /api/v0/order/info/{id}` **[capturado]** (retry: true ok)

Campos relevantes: `status` ("pending"→pago/"released"→"posted"→"delivered" |
"canceled"), `tracking` ("" até postagem ⇒ null no contrato), `price` (reais),
`insurance_value` (**string**, ex. `"30"` — prova do valor declarado no envio),
`print.url`, `service_id`, `from/to` (com `location_number`, não `number`),
`height/width/length/weight` (cm/kg), `products[]`, `tags[]`.

### 5) Cancelar — `POST /api/v0/order/cancel` **[capturado]**

Request: `{"order":{"id":"<id>","description":"motivo"}}` →
Response 200: `{"<id>":{"canceled":true}}`. Pendente cancela sem custo; paga
estorna crédito p/ carteira (validade 10 dias, auto-cancel com estorno).

### 6) Carteira — `GET /api/v0/user` **[capturado]** (retry: true ok)

`{"balance":0,"limits":{"shipments":0,"shipments_available":5},...}` — balance em
REAIS float ⇒ centavos Int no contrato. Sandbox atual: saldo R$ 0,00 e franquia
`shipments_available: 5` (recarga extra: Pix simulado no painel sandbox).

## Conversões (obrigatórias na implementação)

- reais float/string do provedor ⇄ **centavos Int** (padrão de `priceToCents` em quote.ts — tolerante a string BR/US).
- gramas ⇄ kg (`weightGrams / 1000`, divisão única); cm inteiros passam direto.
- `unitary_value`/`quantity` de products: **strings** com 2 casas (plugin) — `(cents/100).toFixed(2)`.
- `insurance_value`: número em reais = `declaredValueCents / 100` (re-clamp defensivo com `getInsuranceLimits()`).

## Casos de borda que o harness (B) exercita e a implementação (A) DEVE tratar

1. `to.document` ausente/inválido → erro `validation` LOCAL (falha rápido, **sem** chamada nem envio meio-criado).
2. CEP inválido (≠ 8 dígitos após strip) → `validation` local; CEP não atendido → `unavailable` (erro do provedor mapeado).
3. Retry de `createLabel` com o MESMO `externalRef` → mesmo `superFreteId`, `reused: true`, sem segunda cobrança (cart dedupado + checkout 409 tolerado).
4. Falha parcial (cart ok, checkout falhou) → retry RETOMA o checkout do mesmo id (não cria novo cart).
5. Saldo/franquia insuficiente → `insufficient_balance` ANTES de tentar (checa `getWalletBalance`; cart pendente não é órfão: fica catalogado e retomável).
6. `declaredValueCents` fora do piso/teto → re-clamp (mesma regra da cotação: piso R$ 24,50 eleva, teto R$ 10.000 limita).
7. Peso > 30 kg ou dimensão implausível → `validation` local (não gasta chamada).
8. `items` vazio ou quantity/preço inválido → `validation` local.
9. Cancelar etiqueta já cancelada → no-op tolerante (`canceled: true`, sem lançar).

## Propriedade de arquivos (paralelo seguro)

| Dono                         | Arquivos                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Orquestrador** (congelado) | `label-types.ts`, `LABEL-CONTRACT.md`                                                                                                   |
| **Agente A**                 | `lib/services/superfrete/labels.ts`, `tests/shipping/superfrete-labels-unit.test.ts`, seção nova no `lib/services/superfrete/README.md` |
| **Agente B**                 | `tests/shipping/labels-harness/**` (stub, cenários, engine, teste stub determinístico, teste de integração sandbox condicional)         |

Identificadores no sandbox: prefixo `rmcards-harness-<cenário>` (B) e
`rmcards-sync0-*` (orquestrador; probe `ZMWwpuoswkgXkwN0uKWz` JÁ CANCELADA).
Ninguém roda `git commit`; o orquestrador commita no final.

# SuperFrete — cotação de frete (`/calculator`)

Integração com o agregador **SuperFrete** para cotar frete (Correios PAC/SEDEX e, quando
elegíveis, Loggi/Jadlog). **Read-only / idempotente**: cotar não gera efeito colateral, então
o cliente re-tenta com backoff e o resultado é cacheável.

> **Mock-first**: sem `SUPERFRETE_TOKEN` + `SUPERFRETE_FROM_CEP` no ambiente, a cotação fica
> **desligada** e o checkout cai no frete flat (`lib/cart/shipping`). Nada quebra em dev.

## Arquivos

| Arquivo         | Papel                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.ts`     | Config por env (mock-first). `getSuperFreteConfig()`, `isSuperFreteConfigured()`.                                                                                  |
| `client.ts`     | HTTP de baixo nível: timeout, retry/backoff+jitter (opt-in via `retry`), Retry-After, log estruturado (token mascarado). `superFreteRequest()` → `{ data, meta }`. |
| `cache.ts`      | Cache opcional em memória (TTL por env, desligado por default).                                                                                                    |
| `dimensions.ts` | Medidas de pacote por categoria + `effectivePackage()` (medida do produto com fallback).                                                                           |
| `quote.ts`      | Parse (segrega cotável × indisponível) + cotação. `quoteShipping()`, `parseQuote()`, `fetchQuote()`.                                                               |
| `record.ts`     | **Adapter de registro normalizado** (tabular) p/ pipeline de dados. `quoteShippingRecords()`, `toQuoteRecords()`.                                                  |

## Uso

```ts
import { quoteShipping } from "@/lib/services/superfrete/quote";
import { quoteShippingRecords } from "@/lib/services/superfrete/record";
import { effectivePackage } from "@/lib/services/superfrete/dimensions";

// unitPriceCents (valor da MERCADORIA com desconto, centavos) liga o SEGURO:
// o valor declarado enviado ao provedor e a soma qty x unitPriceCents, clampada
// aos limites do provedor (config). Sem valor em nenhum item, seguro desligado.
const items = lines.map((l) => ({
  quantity: l.quantity,
  pkg: effectivePackage(l.product),
  unitPriceCents: finalPriceCents(l.product),
}));

// 1) Checkout — só as modalidades com preço, ordenadas asc. [] = indisponível (cai no flat).
const options = await quoteShipping("80010-000", items);
// [{ serviceCode: 1, name: "PAC", carrier: "Correios", priceCents: 2350, days: 6 }, ...]

// 2) Pipeline de dados — registro normalizado, UMA linha por modalidade (cotável e indisponível).
const records = await quoteShippingRecords("80010-000", items);
```

### Registro normalizado (`ShippingQuoteRecord`)

Plano e tabular (todos os campos escalares), uma linha por modalidade. Métricas **distintas**:
`quotedPriceCents` = **valor cotado** (já com desconto); `postAuditPriceCents` = **valor
pós-conferência** (a transportadora reconfere peso/medidas na postagem) — sempre `null` na
cotação, preenchido depois pelo evento de postagem. Itens indisponíveis são **segregados**
(`available: false` + `unavailableReason`), nunca descartados.

| coluna                                               | tipo                | nota                                                                                      |
| ---------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `requestId`                                          | string              | correlaciona com o log `[superfrete]`                                                     |
| `rowIndex`                                           | int                 | **chave de linha**: `(requestId, rowIndex)` é única/estável (use isto, não `serviceCode`) |
| `quotedAt`                                           | string              | ISO-8601 da **materialização** (num cache-hit ≠ hora da chamada — ver notas)              |
| `httpStatus` / `latencyMs` / `attempts` / `cacheHit` | num/bool            | observabilidade da chamada                                                                |
| `fromCep` / `toCep`                                  | string              | rota (dimensional; nunca logado)                                                          |
| `totalWeightKg` / `itemCount`                        | number              | pacote (peso somado em gramas Int e dividido uma vez — sem ruído de FP)                   |
| `serviceCode` / `carrier` / `serviceName`            | num/string          | modalidade (`serviceCode` pode repetir/ser 0 — não é chave)                               |
| `available` / `unavailableReason`                    | bool / string\|null | segregação (reason = texto cru do provedor)                                               |
| `quotedPriceCents`                                   | int\|null           | **valor cotado**                                                                          |
| `postAuditPriceCents`                                | int\|null           | **valor pós-conferência** (null na cotação)                                               |
| `deliveryDays`                                       | int\|null           | prazo em dias úteis                                                                       |

**Notas para o pipeline:**

- **Grão da linha** = `(requestId, rowIndex)`. `serviceCode` é descritivo (pode colidir em 0 / repetir).
- **Cotação vazia**: uma resposta 200 sem nenhuma modalidade cotável devolve `[]` (zero linhas) — o metadado dessa chamada ainda está no log `[superfrete]` (mesmo `requestId`). Se precisar de uma linha-envelope para essas chamadas, materialize-a no consumidor.
- **`quotedAt` em cache-hit**: é a hora do consumo; `cacheHit=true` + `requestId` reconciliam a idade real ao particionar por tempo.
- **`unavailableReason`** é texto livre do provedor (varia com idioma/wording); para agregação estável, derive um código categórico no consumidor a partir de `available`/`quotedPriceCents`.

## Configuração / segredos

Pelo mecanismo do projeto (env vars; mock-first; **zero segredo versionado**). Veja
`.env.example`:

```bash
SUPERFRETE_API_URL=https://sandbox.superfrete.com   # produção: https://api.superfrete.com
SUPERFRETE_TOKEN=                                    # POR AMBIENTE (sandbox ≠ produção)
SUPERFRETE_USER_AGENT=RM Cards (contato@rmcardstcg.com.br)  # obrigatório pela API
SUPERFRETE_FROM_CEP=                                 # CEP de origem da loja (só dígitos)
SUPERFRETE_CACHE_TTL_MS=                             # opcional; 0/ausente = cache desligado
SUPERFRETE_INSURANCE_MIN_CENTS=                      # piso do valor declarado (default 2450 = R$24,50)
SUPERFRETE_INSURANCE_MAX_CENTS=                      # teto do valor declarado (default 1000000 = R$10.000)
```

### Seguro / valor declarado

A cotação envia `options.use_insurance_value: true` + `options.insurance_value`
(REAIS) sempre que os itens têm `unitPriceCents` — valor declarado = soma da
MERCADORIA (nunca o frete), centavos Int divididos UMA vez, clampado ao
piso/teto acima. Itens sem valor (fluxos legados) mantêm o seguro desligado. O
valor declarado também compõe a chave do cache (seguro diferente ⇒ preço
diferente).

**Limites confirmados no sandbox real (2026-07-01):** piso **R$ 24,50** —
abaixo disso o provedor devolve TODAS as modalidades como item-erro ("Valor
segurado é abaixo do limite mínimo"); no piso o prêmio observado é **zero**,
por isso o default eleva o declarado ao piso em vez de desligar o seguro. Teto
**por modalidade**: PAC R$ 3.000, SEDEX R$ 10.000 — o provedor segrega apenas a
modalidade que estoura (nosso parser preserva as cotáveis), então o clamp local
usa o teto global (SEDEX). Evidência de custo (mesmo pacote/rota): sem seguro
PAC 18,71; declarado R$ 2.500 → PAC 47,18 (ad valorem ≈ 1,14%).

## Testes

```bash
npx vitest run tests/shipping        # parse, adapter, cliente (retry/401/429), cache — sem rede
```

Integração real (Fase 4), **condicional ao token** — pulada sem env:

```bash
SUPERFRETE_TOKEN=<sandbox> SUPERFRETE_FROM_CEP=01310100 \
SUPERFRETE_API_URL=https://sandbox.superfrete.com \
npx vitest run tests/shipping/superfrete-sandbox.integration.test.ts
```

---

## Plano (Fase 0) — decisões adotadas

- **Stack/padrões reutilizados** (não criados): cliente HTTP no molde do Asaas
  (`lib/services/asaas/client.ts` — fetch + `AbortSignal.timeout` + retry/backoff+jitter +
  Retry-After + erro tipado); config por env mock-first; log `console.info/error("[service]", obj)`;
  testes Vitest em `tests/` com `vi.stubGlobal("fetch", …)`.
- **Suposição registrada** (contrato provisório, validar na Fase 4): payload usa `products[]`
  (array, cubagem no SuperFrete) em vez do `package` único — capacidade documentada da API e o
  formato certo para carrinho multi-linha. Os nomes de campo da resposta (`price`,
  `delivery_time`, `company.name`, `error`) são hipótese validada pelo teste de sandbox.
- **Itens-erro**: segregados (não descartados) — o pipeline registra a modalidade sem cotação.
- **Resiliência**: a cotação opta por `retry: true` (idempotente); 401/400 nunca re-tentam.
- **Cache**: opt-in por TTL, em memória por instância; serve checkout e pipeline pela mesma chave.
- **Sem over-engineering**: nenhuma abstração especulativa para outros endpoints.

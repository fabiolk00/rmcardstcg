# Matriz de testes — integração de frete (SuperFrete)

Suíte determinística que valida a integração de cotação de frete de ponta a
ponta (config → client → quote → parse → record → regra de frete grátis), com o
provedor simulado no boundary do `fetch`. Integração real fica no grupo
opcional `superfrete-sandbox.integration.test.ts` (condicional a
`SUPERFRETE_TOKEN`).

## Contrato descoberto (Fase 0)

- **Provedor:** SuperFrete (agregador; Correios PAC=`1` / SEDEX=`2`),
  `POST /api/v0/calculator`.
- **Inputs:** `from`/`to.postal_code` (8 dígitos), `services: "1,2"`,
  `products[]` = `{quantity, weight (kg), height/width/length (cm)}` — uma linha
  por item do carrinho; a **cubagem** é consolidada pelo provedor.
  `options.use_insurance_value` fixado em `false`.
- **Outputs:** array de `{id, name, price, delivery_time, company.name, error?}`
  → `parseQuote` segrega cotáveis (asc por preço) × indisponíveis (`error`).
- **Regras de negócio:** frete grátis com mercadoria ≥ R$ 299,00
  (`FREE_SHIPPING_THRESHOLD_CENTS = 29900`); abaixo, cobra o valor cotado; sem
  cotação (mock-first / erro / indisponível) cai no flat R$ 25,00. CEP = 8
  dígitos após remover máscara. Cache opt-in por TTL (desligado nos testes).
- **Suposições do simulador** (`fixtures/superfrete-fake.ts`, função pura):
  peso faturável = max(real, cubado a 6000 cm³/kg); preço/prazo crescem com a
  zona (derivada do prefixo REAL do CEP) e com o peso; PAC < SEDEX; sobretaxa e
  prazo extra em área remota; limite 30 kg por modalidade; CEP não atendido →
  itens-erro; CEP inexistente → HTTP 400.

## Fixtures

| Arquivo                       | Conteúdo                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fixtures/addresses.ts`       | 20 endereços com CEPs reais (origem 01310-100/SP; capitais e interiores de todas as macrorregiões; remotos: Noronha/PE, Humaitá/AM, Oiapoque/AP) + bordas de CEP (formato inválido, inexistente, não atendido, com/sem hífen). Builder determinístico (seed fixo). |
| `fixtures/products.ts`        | 10 produtos TCG (single bulk R$ 5, carta rara R$ 2.500, lote 100 cartas, booster, booster box, ETB, deck precon, sleeves, deck box, playmat enrolado) com SKU/categoria/peso (g)/dimensões (cm)/preço (centavos).                                                  |
| `fixtures/superfrete-fake.ts` | Simulador puro do `/calculator` + `installSuperFreteFake()` (padrão do repo: `vi.stubGlobal("fetch")`), com captura de payload e modelo `expectedServices()` exportado para calcular o esperado sem drift.                                                         |

## Resultado (22 testes, 100% verde — `npx vitest run tests/shipping/superfrete-matrix.test.ts`)

| #   | Cenário                               | Input-chave                                                 | Esperado                                                                                                                                                                   | Obtido                        | Status         |
| --- | ------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------- |
| M1  | Carta avulsa → CEP local              | SGL-BULK (50 g fallback) → 01001-000                        | PAC no piso, < R$ 30, prazo mínimo, ordenado                                                                                                                               | igual ao modelo puro          | ✅             |
| M2  | Distância crescente                   | mesmo item → SP→…→Manaus→Humaitá                            | preço/prazo não-decrescentes; remoto estritamente maior                                                                                                                    | monotônico; Humaitá > Manaus  | ✅             |
| M3  | Peso e cubagem                        | booster×box, single×ETB; playmat vs deck box (300 g iguais) | mais pesado custa mais; cubado domina                                                                                                                                      | playmat > deck box            | ✅             |
| M4  | Carrinho misto                        | 3×single + 2×sleeves + 1×deck → BH                          | 3 `products` (qty, kg, cm) preservados; preço consolida o pacote                                                                                                           | payload exato; preço = modelo | ✅             |
| M5  | Alto valor (R$ 2.500)                 | SGL-RARE → RJ; par de controle mesmo pacote R$ 5            | seguro ligado, `insurance_value: 2500` (mercadoria, nunca frete); custo maior no delta ad valorem; bordas: sem valor/zero → off, R$ 15.000 → clamp R$ 10.000, piso via env | conforme (5 casos)            | ✅ (corrigido) |
| M6  | Acima do threshold                    | mercadoria 31 270 / 29 900 exato                            | frete 0 mesmo com cotação válida                                                                                                                                           | 0                             | ✅             |
| M7  | Logo abaixo                           | mercadoria 19 270 e 29 899                                  | cobra o valor cotado (> 0)                                                                                                                                                 | = PAC cotado                  | ✅             |
| M8  | CEP inválido/inexistente/não atendido | 5 formatos inválidos; 99999-999; 00000-000; hífen           | `[]` sem rede; `SuperFreteError(400)` tipado + fallback flat; segregação com razão; hífen ≡ sem hífen                                                                      | conforme                      | ✅             |
| M9  | Peso extremo                          | 40× ETB (38 kg)                                             | sem throw; 2 modalidades segregadas c/ razão do limite; `totalWeightKg=38`                                                                                                 | conforme                      | ✅             |
| M10 | Múltiplas modalidades                 | deck → Recife/Cuiabá/Floripa                                | PAC+SEDEX asc; SEDEX mais caro e mais rápido; prazos > 0                                                                                                                   | conforme                      | ✅             |

**Prova de sensibilidade (anti-verde-vácuo):** mutação proposital na conversão
g→kg de `buildProductsPayload` derruba 14/22 testes; revertida.

## Achados / inconsistências da integração

1. **Seguro/valor declarado não integrado** (M5) — **CORRIGIDO**: `quote.ts`
   agora envia `options.use_insurance_value: true` + `options.insurance_value`
   (reais) sempre que os itens carregam `unitPriceCents` (valor da mercadoria
   com desconto, nunca o frete), clampado ao piso/teto do provedor
   (`SUPERFRETE_INSURANCE_MIN/MAX_CENTS`, default 0 / R$ 10.000). O valor
   declarado entra na chave do cache. Validação no sandbox real: caso
   dedicado em `superfrete-sandbox.integration.test.ts` (R$ 5 vs R$ 2.500 no
   mesmo pacote, delta logado como evidência) — condicional a
   `SUPERFRETE_TOKEN` e a rede liberada para `sandbox.superfrete.com`.
2. Nenhum outro desvio: guards de CEP/itens, normalização de hífen, ordenação,
   segregação de modalidades indisponíveis, conversões g→kg e preço→centavos e
   o threshold exato de frete grátis se comportaram conforme o contrato.

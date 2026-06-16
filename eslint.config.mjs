// eslint.config.mjs — ESLint 9 flat config para o Next 16.
//
// O Next 16 removeu o subcomando `next lint`; o lint agora roda pelo ESLint CLI
// (`eslint .`). O eslint-config-next@16 JA exporta flat config nativa (um array
// Linter.Config[]), entao basta dar spread — sem FlatCompat/@eslint/eslintrc.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

/** @type {import('eslint').Linter.Config[]} */
const config = [
  // Replica 1:1 o antigo .eslintrc.json { "extends": "next/core-web-vitals" }.
  ...nextCoreWebVitals,

  // INV-9 (funcao pura client-safe nao importa prisma): estes arquivos sao
  // CLIENT-SAFE por design — componentes do navegador os importam. Importar o
  // cliente Prisma (lib/db) vaza o driver do banco (pg/net/tls) pro bundle. So
  // `import type` e permitido (tipos somem no build). Barra o import de runtime
  // do cliente; um vazamento aqui passava por typecheck/build sem ser visto.
  {
    files: ["lib/cart/**/*.{ts,tsx}", "lib/data/pricing.ts", "lib/data/orderTransitions.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/db",
                "**/lib/db",
                "../db",
                "./db",
                "@prisma/client",
                "**/generated/prisma",
                "**/generated/prisma/**",
              ],
              allowTypeImports: true,
              message:
                "INV-9: arquivo client-safe nao pode importar o cliente Prisma (vazaria o driver do banco pro bundle). Use `import type`, ou mova o codigo server-only para outro modulo.",
            },
          ],
        },
      ],
    },
  },

  // Ignores adicionais. node_modules/ e .git/ ja sao ignorados por padrao; o
  // config do Next ja ignora .next/out/build/next-env.d.ts. Aqui adicionamos o
  // output do Prisma (gerado) e dirs de build/coverage.
  {
    ignores: ["lib/generated/**", "coverage/**", ".vercel/**"],
  },
];

export default config;

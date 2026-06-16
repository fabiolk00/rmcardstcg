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

  // `react-hooks/set-state-in-effect` e NOVO no react-hooks 7 (veio com o Next 16).
  // Ele sinaliza setState dentro de useEffect — mas isso e LEGITIMO em padroes
  // existentes do app: hidratacao de estado client-only (CartContext lendo
  // localStorage no mount, que nao pode rodar no SSR) e reset de pagina derivado
  // de filtros (ColecoesView/Admin*). Mantido como nao-bloqueante para nao reescrever
  // componentes numa migracao de tooling; revisitar caso a caso se quiser refatorar.
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
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

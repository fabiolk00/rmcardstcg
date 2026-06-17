import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

// Resolve o alias "@/..." do tsconfig (paths) para a raiz do projeto. Usa regex
// ancorada em "@/" para NAO afetar pacotes de escopo como @clerk/* e @prisma/*.
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.resolve(process.cwd())}/` }],
  },
  test: {
    // Os specs Playwright (tests/e2e/** e tests/harness/**) rodam pelo runner do
    // Playwright, nao pelo vitest — excluir evita que `vitest run` os colete e
    // quebre (eles importam @playwright/test).
    exclude: [...configDefaults.exclude, "tests/e2e/**", "tests/harness/**"],
    // Os caminhos de dados batem em Postgres real; sem timeouts curtos demais.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

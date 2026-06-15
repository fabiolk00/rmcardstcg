import path from "node:path";

import { defineConfig } from "vitest/config";

// Resolve o alias "@/..." do tsconfig (paths) para a raiz do projeto. Usa regex
// ancorada em "@/" para NAO afetar pacotes de escopo como @clerk/* e @prisma/*.
export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${path.resolve(process.cwd())}/` }],
  },
  test: {
    // Os caminhos de dados batem em Postgres real; sem timeouts curtos demais.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Sonda de FORMA (estatica, sem banco) para o INV-4 — dominio camelCase, banco
// snake_case via @map; a camada lib/data traduz.
//
// Os CONTRATOS de dominio (lib/data/types.ts) sao o que as telas consomem. Se um
// campo snake_case aparecer aqui, uma row crua do Postgres vazou para o dominio
// sem traducao (ex.: `total_cents` em vez de `totalCents`) — quebra o INV-4. Esta
// sonda le os nomes de campo das interfaces e exige que nenhum seja snake_case.
// (Comentarios/JSDoc com snake_case sao ignorados — so olhamos declaracoes `nome:`.)

const src = readFileSync(path.join(process.cwd(), "lib/data/types.ts"), "utf8");

describe("INV-4 (forma) — contratos de dominio em camelCase", () => {
  it("nenhum campo das interfaces em lib/data/types.ts e snake_case", () => {
    // Campos de interface: linhas indentadas `  nome: tipo` / `  nome?: tipo`.
    // Linhas de comentario (comecam com / ou *) e de union (|) nao casam.
    const fieldRe = /^\s{2,}([a-zA-Z_$][\w$]*)\??:\s/gm;
    const offenders: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(src)) !== null) {
      if (m[1].includes("_")) offenders.push(m[1]);
    }
    expect(
      offenders,
      `INV-4: campo(s) snake_case vazando no dominio (lib/data/types.ts): ${offenders.join(
        ", ",
      )}. O dominio e camelCase — mapeie a coluna no lib/data (toOrder/toProduct/...).`,
    ).toEqual([]);
  });
});

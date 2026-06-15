#!/usr/bin/env bash
# QA gate do RM Cards. Chamado pelo hook TaskCompleted (e TeammateIdle).
# Exit 2  -> bloqueia a conclusao da task e devolve feedback ao teammate (forca novo "fix").
# Exit 0  -> task pode concluir.
# Le o JSON do evento via stdin (nao e obrigatorio usar, mas esta disponivel).

set -uo pipefail

INPUT="$(cat || true)"
IS_IDLE="no"
[[ "${1:-}" == "--idle" ]] && IS_IDLE="yes"

FAILED=0
REPORT=""

run() {
  local label="$1"; shift
  local out
  if ! out="$("$@" 2>&1)"; then
    FAILED=1
    REPORT+=$'\n=== '"$label"$' FALHOU ===\n'"$out"$'\n'
  fi
}

# Gates estaticos baratos primeiro (falham rapido).
run "typecheck (tsc --noEmit)" pnpm typecheck
run "lint (eslint --max-warnings 0)" pnpm lint
run "format:check (prettier)" pnpm format:check

# Gate de N+1: a suite deve falhar se qualquer caminho instrumentado passar de 15 queries.
# O teste real vive em tests/nplusone/*.test.ts e usa o helper scripts/count-queries.ts.
if [[ -f "package.json" ]] && grep -q '"test:nplusone"' package.json; then
  run "N+1 (threshold=15)" pnpm test:nplusone
fi

# Build por ultimo (mais caro). Pulado no modo idle para nao travar o teammate em loop.
if [[ "$IS_IDLE" == "no" ]]; then
  run "build (prisma generate + next build)" pnpm build
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "QA gate REPROVADO. Corrija e marque a task de novo." >&2
  echo "$REPORT" >&2
  exit 2
fi

echo "QA gate aprovado." >&2
exit 0

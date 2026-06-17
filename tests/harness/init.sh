#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Wrapper idempotente do HARNESS de admin (RM Cards).
#
# Roda o smoke de admin contra um Postgres efemero REAL em modo mock-first:
# sobe embedded-postgres numa porta aleatoria, materializa o schema (prisma db
# push), aplica CHECKs/LOWER(code), seed, e roda o Playwright (config do harness,
# webServer = `next dev` na porta 3200). Teardown do PG no finally do runner.
#
# Idempotente: cada execucao e um run isolado (banco novo e descartavel). Pode
# rodar quantas vezes quiser; nada persiste entre runs.
#
# Plataforma: Git Bash no Windows (ou qualquer bash POSIX). Resolve o diretorio
# do repo a partir da localizacao deste script para poder ser chamado de
# qualquer cwd.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"

echo "[harness/init] repo: ${REPO_ROOT}"
echo "[harness/init] rodando smoke de admin (mock-first, PG efemero)..."

pnpm tsx scripts/harness-with-ephemeral-pg.ts tests/harness/smoke.admin.spec.ts --reporter=line

#!/usr/bin/env bash
# scripts/simulate-main.sh
# Simulates the main.yml pipeline locally (minus staging deploy + Docker push).
# Requires: Docker running (for PostgreSQL), Node 20+.
# Usage: bash scripts/simulate-main.sh [--skip-integration]

set -euo pipefail

SKIP_INTEGRATION=false
for arg in "$@"; do [[ "$arg" == "--skip-integration" ]] && SKIP_INTEGRATION=true; done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

# ── 1. Install ────────────────────────────────────────────────────────────────
step "npm ci --legacy-peer-deps"
npm ci --legacy-peer-deps

# ── 2. OpenAPI types ──────────────────────────────────────────────────────────
step "OpenAPI → TypeScript (generate)"
npm run generate:types

# ── 3. TypeScript typecheck ───────────────────────────────────────────────────
step "TypeScript typecheck"
npx tsc --noEmit

# ── 4. Integration tests ──────────────────────────────────────────────────────
if [[ "$SKIP_INTEGRATION" == "true" ]]; then
  warn "Skipping integration tests (--skip-integration)"
else
  step "Starting PostgreSQL test container"
  docker rm -f hv_sim_pg 2>/dev/null || true
  docker run -d \
    --name hv_sim_pg \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=harmoven_test \
    -e POSTGRES_USER=postgres \
    -p 5433:5432 \
    postgres:16

  echo "Waiting for PostgreSQL..."
  for i in $(seq 1 20); do
    docker exec hv_sim_pg pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done

  step "Run migrations"
  DATABASE_URL="postgresql://postgres:test@localhost:5433/harmoven_test" \
    npx prisma migrate deploy

  step "Run integration tests"
  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    warn "ANTHROPIC_API_KEY not set — skipping live LLM integration tests"
    warn "Set ANTHROPIC_API_KEY=sk-ant-... and re-run to include them"
  else
    DATABASE_URL="postgresql://postgres:test@localhost:5433/harmoven_test" \
    HARMOVEN_LLM_TIER=haiku \
      npm run test:integration
  fi

  step "Cleanup PostgreSQL container"
  docker rm -f hv_sim_pg
fi

# ── 5. Unit tests (sanity) ────────────────────────────────────────────────────
step "Unit tests (mock — sanity check)"
HARMOVEN_LLM_TIER=mock npm run test:unit

# ── 6. Docker build (local — no push) ─────────────────────────────────────────
step "Docker build (local, no push)"
docker build -t harmoven-app:sim-main-local . 2>&1 | tail -5
echo "Image built: harmoven-app:sim-main-local"
warn "Docker push skipped (needs DOCKER_TOKEN secret in real CI)"

# ── 7. Summary ────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}✓ main.yml simulation complete${NC}"
echo "  • Staging deploy and smoke tests skipped (need live staging)"
echo "  • Docker push skipped (need DOCKER_TOKEN secret)"
echo "  • Set ANTHROPIC_API_KEY to run live integration tests"

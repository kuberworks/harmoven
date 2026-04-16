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

# ── 6. Docker build + push + Fly.io staging deploy ───────────────────────────
step "Docker build"
docker build -t harmoven-app:sim-main-local . 2>&1 | tail -5
echo "Image built: harmoven-app:sim-main-local"
if [[ -n "${DOCKER_TOKEN:-}" ]]; then
  step "Docker push (sha tag)"
  DOCKER_USERNAME="${DOCKER_USERNAME:-harmoven}"
  echo "$DOCKER_TOKEN" | docker login -u "$DOCKER_USERNAME" --password-stdin
  docker tag harmoven-app:sim-main-local "harmoven/app:${GITHUB_SHA:-sim-main-local}"
  docker push "harmoven/app:${GITHUB_SHA:-sim-main-local}"
  echo "Pushed: harmoven/app:${GITHUB_SHA:-sim-main-local}"

  if [[ -n "${FLY_API_TOKEN:-}" ]]; then
    step "Fly.io staging deploy (harmoven-staging)"
    if ! command -v flyctl >/dev/null 2>&1; then
      warn "flyctl not found — install with: brew install flyctl"
    else
      FLY_API_TOKEN="$FLY_API_TOKEN" flyctl deploy \
        --app harmoven-staging \
        --image "harmoven/app:${GITHUB_SHA:-sim-main-local}" \
        --strategy rolling --wait-timeout 120
      echo "Staging smoke test..."
      for i in $(seq 1 10); do
        curl -sf https://harmoven-staging.fly.dev/api/health && echo ' OK' && break
        sleep 5
      done
    fi
  else
    warn "Fly.io deploy skipped — set FLY_API_TOKEN to deploy to harmoven-staging"
  fi
else
  warn "Docker push skipped — set DOCKER_TOKEN (+ DOCKER_USERNAME, default: harmoven)"
  warn "Fly.io deploy skipped — requires Docker push first"
fi

# ── 7. Summary ────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}✓ main.yml simulation complete${NC}"
[[ -z "${DOCKER_TOKEN:-}" ]] && echo "  • Docker push: skipped (set DOCKER_TOKEN + DOCKER_USERNAME to push)"
[[ -z "${FLY_API_TOKEN:-}" ]] && echo "  • Fly.io staging: skipped (set FLY_API_TOKEN to deploy)"
echo "  • Set ANTHROPIC_API_KEY to run live integration tests"

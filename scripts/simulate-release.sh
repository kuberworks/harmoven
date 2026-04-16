#!/usr/bin/env bash
# scripts/simulate-release.sh
# Simulates the release.yml pipeline locally for a given version tag.
# Skips: code signing/notarization (requires Apple/EV certs), Docker push,
#        GitHub Release creation, release pins write.
# Usage: bash scripts/simulate-release.sh v1.0.0

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: bash scripts/simulate-release.sh v1.0.0" >&2; exit 1
fi
# Validate semver tag format
if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-.+)?$ ]]; then
  echo "Error: version must be in format v1.2.3 (or v1.2.3-rc.1)" >&2; exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }

export GITHUB_REF="refs/tags/$VERSION"
export GITHUB_SHA="$(git rev-parse HEAD)"

# ── 1. Install ────────────────────────────────────────────────────────────────
step "npm ci --legacy-peer-deps"
npm ci --legacy-peer-deps

# ── 2. OpenAPI types ──────────────────────────────────────────────────────────
step "OpenAPI → TypeScript"
npm run generate:types

# ── 3. TypeScript typecheck ───────────────────────────────────────────────────
step "TypeScript typecheck"
npx tsc --noEmit

# ── 4. Unit tests ─────────────────────────────────────────────────────────────
step "Unit tests (mock)"
HARMOVEN_LLM_TIER=mock npm run test:unit

# ── 5. E2E tests ──────────────────────────────────────────────────────────────
step "Starting PostgreSQL for E2E tests"
docker rm -f hv_sim_pg_e2e 2>/dev/null || true
docker run -d \
  --name hv_sim_pg_e2e \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=harmoven_test \
  -e POSTGRES_USER=postgres \
  -p 5434:5432 \
  postgres:16

echo "Waiting for PostgreSQL..."
for i in $(seq 1 20); do
  docker exec hv_sim_pg_e2e pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

step "Run migrations (E2E DB)"
DATABASE_URL="postgresql://postgres:test@localhost:5434/harmoven_test" \
  npx prisma migrate deploy

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  warn "ANTHROPIC_API_KEY not set — skipping Playwright E2E tests"
  warn "Set ANTHROPIC_API_KEY=sk-ant-... and re-run to include them"
else
  step "Playwright E2E tests"
  if ! npx playwright --version >/dev/null 2>&1; then
    npx playwright install --with-deps chromium
  fi
  DATABASE_URL="postgresql://postgres:test@localhost:5434/harmoven_test" \
  HARMOVEN_LLM_TIER=sonnet \
    npm run test:e2e
fi

step "Cleanup E2E PostgreSQL container"
docker rm -f hv_sim_pg_e2e

# ── 6. Docker build + push ───────────────────────────────────────────────────
step "Docker build"
VERSION_SHORT="${VERSION#v}"
docker build -t "harmoven-app:${VERSION_SHORT}" . 2>&1 | tail -5
echo "Image built: harmoven-app:${VERSION_SHORT}"
if [[ -n "${DOCKER_TOKEN:-}" ]]; then
  step "Docker push release image"
  DOCKER_USERNAME="${DOCKER_USERNAME:-harmoven}"
  echo "$DOCKER_TOKEN" | docker login -u "$DOCKER_USERNAME" --password-stdin
  docker tag "harmoven-app:${VERSION_SHORT}" "harmoven/app:${VERSION_SHORT}"
  docker tag "harmoven-app:${VERSION_SHORT}" "harmoven/app:latest"
  docker tag "harmoven-app:${VERSION_SHORT}" "harmoven/app:${GITHUB_SHA}"
  docker push "harmoven/app:${VERSION_SHORT}"
  docker push "harmoven/app:latest"
  docker push "harmoven/app:${GITHUB_SHA}"
  echo "Pushed: harmoven/app:${VERSION_SHORT}, harmoven/app:latest, harmoven/app:${GITHUB_SHA}"
else
  warn "Docker push skipped — set DOCKER_TOKEN (+ DOCKER_USERNAME, default: harmoven)"
fi

# ── 7. Electron build (Linux only — macOS/Windows require CI runners + certs) ──
step "Electron build — Linux AppImage"
if npm run build:electron:linux 2>&1 | tail -5; then
  echo "Linux Electron build: OK"
  ls dist/*.AppImage dist/*.deb dist/*.rpm 2>/dev/null || warn "No .AppImage/.deb/.rpm in dist/"
else
  warn "Electron build failed (may need electron-builder configured)"
fi
warn "macOS build skipped (requires Apple certificate in Keychain)"
warn "Windows build skipped (requires EV certificate + windows-latest runner)"

# ── 8. CHANGELOG preview ─────────────────────────────────────────────────────
step "CHANGELOG section preview for $VERSION"
if npx conventional-changelog-cli --version >/dev/null 2>&1; then
  npx conventional-changelog-cli -p angular -r 1 --tag-prefix v 2>/dev/null || \
    warn "No CHANGELOG generated (conventional-changelog-cli may need config)"
else
  warn "conventional-changelog-cli not installed — run: npm install -D conventional-changelog-cli"
fi

# ── 9. Summary ────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}✓ release.yml simulation complete for $VERSION${NC}"
echo "  • macOS + Windows Electron builds: skipped (need GitHub CI + certs)"
[[ -z "${DOCKER_TOKEN:-}" ]] && echo "  • Docker push: skipped (set DOCKER_TOKEN + DOCKER_USERNAME to push)"
echo "  • GitHub Release creation: skipped (need GITHUB_TOKEN)"
echo "  • Release pins write: skipped (need config.git access)"
echo "  • Set ANTHROPIC_API_KEY to run Playwright E2E tests"

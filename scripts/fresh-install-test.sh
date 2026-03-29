#!/usr/bin/env bash
# =============================================================================
# scripts/fresh-install-test.sh — Harmoven Fresh Installation Test
# =============================================================================
#
# Validates a brand-new Harmoven installation end-to-end:
#   1.  Pre-flight checks (Docker, Node, env vars, API keys, port availability)
#   2.  Isolated PostgreSQL container (default port 5435, named volume)
#   3.  Prisma migrations from scratch (empty DB)
#   4.  Database seed (built-in roles + admin user)
#   5.  Next.js dev server on port 3001
#   6.  API smoke tests (auth, projects, runs)
#   7.  Real LLM run — Anthropic Claude 4   (CLASSIFIER→PLANNER→WRITER→REVIEWER)
#   8.  Real LLM run — CometAPI             (same pipeline, server restarted)
#   9.  Cost & token verification (must be non-zero after every real run)
#  10.  Cleanup (containers + volumes, unless --keep)
#
# Usage:
#   bash scripts/fresh-install-test.sh [OPTIONS]
#
# Options:
#   --db-port PORT       PostgreSQL host port          (default: 5435)
#   --app-port PORT      Next.js dev server port        (default: 3001)
#   --keep               Keep containers/volumes after run
#   --skip-cometapi      Skip CometAPI LLM test
#   --skip-anthropic     Skip Anthropic LLM test
#   --timeout SECS       Max seconds to wait for run completion (default: 150)
#   --help               Show this message
#
# Requirements:
#   Docker ≥ 24, Node.js ≥ 22, npm, tsx (via npx)
#   ANTHROPIC_API_KEY and COMETAPI_API_KEY set in .env
#
# =============================================================================
set -euo pipefail

# ─── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# ─── Defaults ────────────────────────────────────────────────────────────────
DB_PORT=5435
APP_PORT=3001
KEEP=false
SKIP_COMETAPI=false
SKIP_ANTHROPIC=false
RUN_TIMEOUT=150

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-port)         DB_PORT="$2";       shift 2 ;;
    --app-port)        APP_PORT="$2";      shift 2 ;;
    --keep)            KEEP=true;          shift   ;;
    --skip-cometapi)   SKIP_COMETAPI=true; shift   ;;
    --skip-anthropic)  SKIP_ANTHROPIC=true;shift   ;;
    --timeout)         RUN_TIMEOUT="$2";   shift 2 ;;
    --help) grep '^# ' "$0" | head -25 | sed 's/^# //' ; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ─── Counters — use POSIX-safe increment (avoids ((VAR++)) exit-code bug) ────
PASS=0; FAIL=0; WARN=0
ERRORS=()

pass() { echo -e "${GREEN}  ✅ PASS${NC} | $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}  ❌ FAIL${NC} | $1"; FAIL=$((FAIL+1)); ERRORS+=("$1"); }
warn() { echo -e "${YELLOW}  ⚠️  WARN${NC} | $1"; WARN=$((WARN+1)); }
info() { echo -e "${CYAN}  ℹ️  INFO${NC} | $1"; }
step() { echo -e "\n${BOLD}${CYAN}══ $1 ══${NC}\n"; }

# ─── Derived config ───────────────────────────────────────────────────────────
CONTAINER_NAME="harmoven-test-${DB_PORT}-db"
VOLUME_NAME="postgres_data_test_${DB_PORT}"
APP_URL="http://localhost:${APP_PORT}"
DB_URL="postgresql://harmoven:${POSTGRES_PASSWORD:-harmoven_qa_test_2026}@localhost:${DB_PORT}/harmoven"
TMP_LOG="/tmp/harmoven-test-${DB_PORT}-app.log"
TMP_COOKIE="/tmp/harmoven-test-${DB_PORT}-cookie.txt"
APP_PID_FILE="/tmp/harmoven-test-${DB_PORT}-app.pid"

# Will be populated by run_llm_test() — avoids stdout capture pollution
LAST_RUN_ID=""

# ─── Cleanup ─────────────────────────────────────────────────────────────────
_cleanup() {
  echo ""
  # Stop app server
  if [[ -f "$APP_PID_FILE" ]]; then
    pid=$(cat "$APP_PID_FILE" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      info "Stopping app server (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$APP_PID_FILE"
  fi
  lsof -ti tcp:"$APP_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true

  # Restore orchestrator.yaml if a backup exists
  if [[ -f orchestrator.yaml.bak ]]; then
    mv orchestrator.yaml.bak orchestrator.yaml 2>/dev/null || true
    info "orchestrator.yaml restored"
  fi

  # Remove containers/volumes
  if [[ "$KEEP" == "true" ]]; then
    info "Keeping test container (--keep). To clean up:"
    info "  docker rm -f ${CONTAINER_NAME} && docker volume rm ${VOLUME_NAME}"
  else
    info "Removing test container + volume..."
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
    docker volume rm "${VOLUME_NAME}"  2>/dev/null || true
  fi

  rm -f "$TMP_COOKIE"
}
trap _cleanup EXIT

# ─── Helpers ─────────────────────────────────────────────────────────────────

wait_pg() {
  local max="${1:-60}" elapsed=0
  while [[ $elapsed -lt $max ]]; do
    if docker exec "${CONTAINER_NAME}" pg_isready -U harmoven -d harmoven -q 2>/dev/null; then
      return 0
    fi
    sleep 2; elapsed=$((elapsed+2))
  done
  return 1
}

wait_http() {
  local url="$1" max="${2:-90}" elapsed=0
  while [[ $elapsed -lt $max ]]; do
    if curl -sf "$url" -o /dev/null 2>/dev/null; then return 0; fi
    sleep 3; elapsed=$((elapsed+3))
  done
  return 1
}

# Authenticated curl (uses cookie jar)
api() {
  local method="$1" path="$2" data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -sf -b "$TMP_COOKIE" -c "$TMP_COOKIE" \
      -X "$method" -H "Content-Type: application/json" -d "$data" \
      "${APP_URL}${path}"
  else
    curl -sf -b "$TMP_COOKIE" -c "$TMP_COOKIE" -X "$method" "${APP_URL}${path}"
  fi
}

do_login() {
  # -s (silent) only — not -f, so HTTP errors don't abort the script.
  # Authentication failures are caught later when API calls return 401.
  curl -s -c "$TMP_COOKIE" -b "$TMP_COOKIE" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"email\":\"${HARMOVEN_ADMIN_EMAIL}\",\"password\":\"${HARMOVEN_ADMIN_PASSWORD}\"}" \
    "${APP_URL}/api/auth/sign-in/email" -o /dev/null || true
}

start_app() {
  local tier="$1" clean_build="${2:-false}"
  info "Starting app server (port=${APP_PORT}, tier=${tier})..."

  # Kill any previous app on this port
  if [[ -f "$APP_PID_FILE" ]]; then
    pid=$(cat "$APP_PID_FILE" 2>/dev/null || true)
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    sleep 2
    rm -f "$APP_PID_FILE"
  fi
  lsof -ti tcp:"$APP_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  sleep 1

  if [[ "$clean_build" == "true" ]]; then
    info "Clearing .next cache for clean build..."
    rm -rf .next 2>/dev/null || true
  fi

  PORT="$APP_PORT" \
  DATABASE_URL="$DB_URL" \
  AUTH_URL="$APP_URL" \
  HARMOVEN_LLM_TIER="$tier" \
  AUTH_SECRET="${AUTH_SECRET}" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  COMETAPI_API_KEY="${COMETAPI_API_KEY:-}" \
  HARMOVEN_ADMIN_EMAIL="${HARMOVEN_ADMIN_EMAIL}" \
  HARMOVEN_ADMIN_PASSWORD="${HARMOVEN_ADMIN_PASSWORD}" \
  HARMOVEN_ENFORCE_ADMIN_MFA=false \
  HARMOVEN_MFA_DISABLE_ACKNOWLEDGED=I_UNDERSTAND_THE_SECURITY_RISK \
  CONFIG_GIT_DIR=/tmp/harmoven-config-git-test \
    npm run dev > "$TMP_LOG" 2>&1 &

  echo $! > "$APP_PID_FILE"
  info "App PID: $(cat "$APP_PID_FILE")"
}

# Runs a real LLM pipeline job and waits for completion.
# Sets LAST_RUN_ID (global) — does NOT use stdout so callers can call
# this function without command substitution capture pollution.
run_llm_test() {
  local provider="$1" project_id="$2"
  LAST_RUN_ID=""

  local payload
  payload=$(printf '{"project_id":"%s","task_input":"Write a 3-sentence email introducing Harmoven to a CTO.","domain_profile":"marketing_content"}' "$project_id")

  local resp run_id
  resp=$(api POST /api/runs "$payload" 2>/dev/null) || true

  # If we got a 401 (session expired after server restart), re-login and retry once
  if echo "$resp" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'error' in str(d).lower() or not d else 1)" 2>/dev/null; then
    info "  Auth may have expired — re-logging in..."
    do_login
    sleep 1
    resp=$(api POST /api/runs "$payload" 2>/dev/null) || true
  fi

  run_id=$(echo "$resp" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); r=d.get('run',d); print(r.get('id',''))" \
    2>/dev/null || echo "")

  if [[ -z "$run_id" ]]; then
    fail "POST /api/runs failed — could not get run ID (${provider})"
    info "  Response snippet: ${resp:0:300}"
    return 0
  fi
  pass "Run created: ${run_id} (${provider})"

  # Poll
  local elapsed=0 status="" cost="0" tokens="0"
  while [[ $elapsed -lt $RUN_TIMEOUT ]]; do
    sleep 4; elapsed=$((elapsed+4))
    local poll
    poll=$(api GET "/api/runs/${run_id}" 2>/dev/null) || continue
    status=$(echo "$poll" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); r=d.get('run',d); print(r.get('status','?'))" \
      2>/dev/null || echo "?")
    cost=$(echo "$poll" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); r=d.get('run',d); print(r.get('cost_actual_usd','0'))" \
      2>/dev/null || echo "0")
    tokens=$(echo "$poll" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); r=d.get('run',d); print(r.get('tokens_actual','0'))" \
      2>/dev/null || echo "0")
    info "  [${elapsed}s] ${status} | tokens=${tokens} | cost=\$${cost}"
    [[ "$status" == "COMPLETED" || "$status" == "FAILED" ]] && break
  done

  LAST_RUN_ID="$run_id"

  if [[ "$status" == "COMPLETED" ]]; then
    pass "Run COMPLETED (${provider}) — ${tokens} tokens — \$${cost}"

    # Cost must be non-zero
    if python3 -c "exit(0 if float('${cost}')>0 else 1)" 2>/dev/null; then
      pass "cost_actual_usd is non-zero: \$${cost} (${provider})"
    else
      fail "cost_actual_usd is 0 after COMPLETED run (${provider})"
    fi

    # Tokens must be non-zero
    if python3 -c "exit(0 if int('${tokens}')>0 else 1)" 2>/dev/null; then
      pass "tokens_actual is non-zero: ${tokens} (${provider})"
    else
      fail "tokens_actual is 0 (${provider})"
    fi

    # Per-node check from DB
    local node_completed
    node_completed=$(docker exec "${CONTAINER_NAME}" psql -U harmoven -d harmoven -t \
      -c "SELECT COUNT(*) FROM \"Node\" WHERE run_id='${run_id}' AND status='COMPLETED';" \
      2>/dev/null | tr -d ' \n')
    if [[ "${node_completed:-0}" -ge 4 ]]; then
      pass "All ${node_completed} pipeline nodes COMPLETED (${provider})"
    else
      fail "Only ${node_completed:-0}/4 nodes COMPLETED (${provider})"
    fi

    local node_cost_nonzero
    node_cost_nonzero=$(docker exec "${CONTAINER_NAME}" psql -U harmoven -d harmoven -t \
      -c "SELECT COUNT(*) FROM \"Node\" WHERE run_id='${run_id}' AND cost_usd > 0;" \
      2>/dev/null | tr -d ' \n')
    if [[ "${node_cost_nonzero:-0}" -ge 1 ]]; then
      pass "Per-node cost tracking: ${node_cost_nonzero} nodes with cost>0 (${provider})"
    else
      fail "All node cost_usd = 0 — per-node cost tracking broken (${provider})"
    fi

    # Print node table
    docker exec "${CONTAINER_NAME}" psql -U harmoven -d harmoven \
      -c "SELECT node_id,agent_type,status,tokens_in,tokens_out,cost_usd FROM \"Node\" WHERE run_id='${run_id}' ORDER BY node_id;" \
      2>/dev/null || true

  elif [[ "$status" == "FAILED" ]]; then
    fail "Run FAILED (${provider})"
    docker exec "${CONTAINER_NAME}" psql -U harmoven -d harmoven \
      -c "SELECT node_id,agent_type,status,error_message FROM \"Node\" WHERE run_id='${run_id}' ORDER BY node_id;" \
      2>/dev/null || true

  else
    fail "Run timed out after ${RUN_TIMEOUT}s (last status: ${status}) (${provider})"
  fi
}

# =============================================================================
# MAIN
# =============================================================================

echo -e "\n${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════════════════════════════╗"
printf "║  HARMOVEN — Fresh Install Test   DB:%-5s  App:%-5s           ║\n" "${DB_PORT}" "${APP_PORT}"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo "Started: $(date)"

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 1 — Pre-flight checks"
# ─────────────────────────────────────────────────────────────────────────────

docker info > /dev/null 2>&1 \
  && pass "Docker is running" \
  || { fail "Docker is not running"; exit 1; }

NODE_VER=$(node -e "console.log(process.version)" 2>/dev/null || echo "none")
if [[ "$NODE_VER" =~ ^v([0-9]+) ]] && [[ "${BASH_REMATCH[1]}" -ge 22 ]]; then
  pass "Node.js ${NODE_VER}"
else
  fail "Node.js ≥22 required (found: ${NODE_VER})"
  exit 1
fi

command -v npm > /dev/null && pass "npm $(npm -v)" || { fail "npm not found"; exit 1; }
npx tsx --version > /dev/null 2>&1 && pass "tsx available" || { fail "tsx not available"; exit 1; }

[[ -f .env ]] && pass ".env file present" || { fail ".env missing — copy .env.example"; exit 1; }

# Load .env
set -a; source .env; set +a

# Update DB_URL now that POSTGRES_PASSWORD is loaded
DB_URL="postgresql://harmoven:${POSTGRES_PASSWORD}@localhost:${DB_PORT}/harmoven"

# Check required vars
REQUIRED_VARS=(ANTHROPIC_API_KEY COMETAPI_API_KEY HARMOVEN_ADMIN_EMAIL HARMOVEN_ADMIN_PASSWORD AUTH_SECRET POSTGRES_PASSWORD)
for var in "${REQUIRED_VARS[@]}"; do
  val="${!var:-}"
  if [[ -z "$val" ]]; then
    fail "${var} is not set in .env"
  else
    pass "${var} set (${val:0:8}…)"
  fi
done

[[ "${ANTHROPIC_API_KEY:-}" =~ ^sk-ant ]] \
  && pass "ANTHROPIC_API_KEY format valid" \
  || warn "ANTHROPIC_API_KEY does not start with sk-ant — may be invalid"

[[ "${COMETAPI_API_KEY:-}" =~ ^sk- ]] \
  && pass "COMETAPI_API_KEY format valid" \
  || warn "COMETAPI_API_KEY does not start with sk- — may be invalid"

# Port checks
if lsof -ti tcp:"$DB_PORT" > /dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "${CONTAINER_NAME}"; then
    info "Removing leftover test container on port ${DB_PORT}..."
    docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
    sleep 2
    pass "DB port ${DB_PORT} cleared"
  else
    fail "DB port ${DB_PORT} in use by another process — use --db-port to pick another"
    exit 1
  fi
else
  pass "DB port ${DB_PORT} is free"
fi

if lsof -ti tcp:"$APP_PORT" > /dev/null 2>&1; then
  info "App port ${APP_PORT} in use — killing..."
  lsof -ti tcp:"$APP_PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi
pass "App port ${APP_PORT} is free"

if [[ $FAIL -gt 0 ]]; then
  echo -e "\n${RED}Pre-flight failed — aborting.${NC}"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 2 — Fresh PostgreSQL on port ${DB_PORT}"
# ─────────────────────────────────────────────────────────────────────────────

# Remove stale volume (ensure truly fresh DB)
docker volume rm "${VOLUME_NAME}" > /dev/null 2>&1 && info "Removed stale volume." || true

docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -e POSTGRES_DB=harmoven \
  -e POSTGRES_USER=harmoven \
  -e "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
  -p "127.0.0.1:${DB_PORT}:5432" \
  -v "${VOLUME_NAME}:/var/lib/postgresql/data" \
  postgres:16-alpine \
  postgres -c synchronous_commit=on \
  > /dev/null

info "Waiting for PostgreSQL to be ready (up to 60s)..."
if wait_pg 60; then
  pass "PostgreSQL healthy on port ${DB_PORT}"
else
  fail "PostgreSQL did not become ready in 60s"
  docker logs "${CONTAINER_NAME}" | tail -20 >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 3 — Prisma migrations (from scratch)"
# ─────────────────────────────────────────────────────────────────────────────

info "Running prisma generate..."
if DATABASE_URL="$DB_URL" npx prisma generate > /tmp/harmoven-gen.log 2>&1; then
  pass "prisma generate OK"
else
  fail "prisma generate failed"
  cat /tmp/harmoven-gen.log >&2
  exit 1
fi

info "Running prisma migrate deploy..."
if DATABASE_URL="$DB_URL" npm run db:migrate > /tmp/harmoven-migrate.log 2>&1; then
  pass "db:migrate completed"
else
  fail "db:migrate failed"
  cat /tmp/harmoven-migrate.log >&2
  exit 1
fi

TABLE_COUNT=$(docker exec "${CONTAINER_NAME}" psql -U harmoven -d harmoven -t \
  -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" \
  2>/dev/null | tr -d ' \n')
if [[ "${TABLE_COUNT:-0}" -gt 10 ]]; then
  pass "${TABLE_COUNT} tables created by migrations"
else
  fail "Only ${TABLE_COUNT:-0} tables after migration (expected >10)"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 4 — Database seed"
# ─────────────────────────────────────────────────────────────────────────────

info "Running db:seed..."
if DATABASE_URL="$DB_URL" \
   HARMOVEN_ADMIN_EMAIL="$HARMOVEN_ADMIN_EMAIL" \
   HARMOVEN_ADMIN_PASSWORD="$HARMOVEN_ADMIN_PASSWORD" \
   npm run db:seed > /tmp/harmoven-seed.log 2>&1; then
  pass "db:seed completed"
else
  fail "db:seed failed"
  cat /tmp/harmoven-seed.log >&2
  exit 1
fi

ROLE_COUNT=$(docker exec "${CONTAINER_NAME}" psql -U harmoven -d harmoven -t \
  -c 'SELECT COUNT(*) FROM "ProjectRole" WHERE is_builtin=true;' \
  2>/dev/null | tr -d ' \n')
[[ "${ROLE_COUNT:-0}" -ge 7 ]] \
  && pass "Built-in roles: ${ROLE_COUNT}" \
  || fail "Expected ≥7 built-in roles, found: ${ROLE_COUNT:-0}"

ADMIN_COUNT=$(docker exec "${CONTAINER_NAME}" psql -U harmoven -d harmoven -t \
  -c "SELECT COUNT(*) FROM \"user\" WHERE email='${HARMOVEN_ADMIN_EMAIL}';" \
  2>/dev/null | tr -d ' \n')
[[ "${ADMIN_COUNT:-0}" -ge 1 ]] \
  && pass "Admin user seeded: ${HARMOVEN_ADMIN_EMAIL}" \
  || fail "Admin user not found in DB after seed"

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 5 — Start app server (Anthropic)"
# ─────────────────────────────────────────────────────────────────────────────

start_app "anthropic" "true"
info "Waiting for app to be ready (up to 120s, Next.js cold start)..."
if wait_http "${APP_URL}/api/health" 120; then
  HEALTH=$(curl -sf "${APP_URL}/api/health" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "?")
  pass "App server healthy at ${APP_URL} (status: ${HEALTH})"
else
  fail "App server did not start in 120s"
  echo "--- Last 30 lines of app log ---"
  tail -30 "$TMP_LOG" >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 6 — API smoke tests"
# ─────────────────────────────────────────────────────────────────────────────

# Login
LOGIN=$(curl -sf -c "$TMP_COOKIE" -b "$TMP_COOKIE" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"${HARMOVEN_ADMIN_EMAIL}\",\"password\":\"${HARMOVEN_ADMIN_PASSWORD}\"}" \
  "${APP_URL}/api/auth/sign-in/email" 2>/dev/null || echo "{}")
LOGIN_EMAIL=$(echo "$LOGIN" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('email','ERR'))" 2>/dev/null || echo "ERR")

if [[ "$LOGIN_EMAIL" == "$HARMOVEN_ADMIN_EMAIL" ]]; then
  pass "Admin login OK"
else
  fail "Admin login failed — response: ${LOGIN:0:200}"
  exit 1
fi

# Health endpoint
H=$(api GET /api/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "?")
[[ "$H" == "ok" ]] && pass "GET /api/health → ok" || fail "GET /api/health → ${H}"

# Version endpoint
api GET /api/health > /dev/null 2>&1 && pass "GET /api/health reachable" || warn "GET /api/health failed on second call"

# Create test project
PROJECT_RESP=$(api POST /api/projects \
  '{"name":"FreshInstallTest","description":"Automated fresh install test"}' 2>/dev/null || echo "{}")
PROJECT_ID=$(echo "$PROJECT_RESP" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); p=d.get('project',d); print(p.get('id',''))" 2>/dev/null || echo "")

if [[ -n "$PROJECT_ID" ]]; then
  pass "POST /api/projects → project created (${PROJECT_ID})"
else
  fail "POST /api/projects failed: ${PROJECT_RESP:0:200}"
  exit 1
fi

# List runs (should work even if empty)
RUNS_RESP=$(api GET /api/runs 2>/dev/null || echo "err")
[[ "$RUNS_RESP" != "err" ]] && pass "GET /api/runs → ok" || fail "GET /api/runs failed"

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 7 — Real LLM test: Anthropic Claude 4"
# ─────────────────────────────────────────────────────────────────────────────

ANTHROPIC_RUN_ID=""
if [[ "$SKIP_ANTHROPIC" == "false" ]]; then
  run_llm_test "anthropic" "$PROJECT_ID"
  ANTHROPIC_RUN_ID="$LAST_RUN_ID"
else
  info "Skipping Anthropic test (--skip-anthropic)"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 8 — Real LLM test: CometAPI"
# ─────────────────────────────────────────────────────────────────────────────

COMETAPI_RUN_ID=""
if [[ "$SKIP_COMETAPI" == "false" ]]; then

  # Update orchestrator.yaml to use CometAPI profiles
  cp orchestrator.yaml orchestrator.yaml.bak
  sed -i.tmp \
    -e 's/default_provider: anthropic/default_provider: cometapi/' \
    -e '/profiles_active:/,/^[^ ]/{
        s/^    - claude-haiku-4-5.*$/    - cometapi-fast/
        s/^    - claude-sonnet-4-6.*$/    - cometapi/
        s/^    - claude-opus-4-6.*$/    - cometapi-powerful/
    }' \
    orchestrator.yaml
  rm -f orchestrator.yaml.tmp
  info "orchestrator.yaml: switched to cometapi profiles"

  # Restart app (no need to clear .next — only env/yaml changed)
  start_app "cometapi" "false"
  info "Waiting for app restart (up to 90s)..."
  if wait_http "${APP_URL}/api/health" 90; then
    pass "App server restarted (CometAPI)"
  else
    fail "App server restart failed for CometAPI"
    tail -20 "$TMP_LOG" >&2
  fi

  # Re-login after restart — wait a moment for auth routes to warm up
  sleep 3
  do_login
  sleep 1

  run_llm_test "cometapi" "$PROJECT_ID"
  COMETAPI_RUN_ID="$LAST_RUN_ID"

  # Restore orchestrator.yaml
  mv orchestrator.yaml.bak orchestrator.yaml
  info "orchestrator.yaml restored"

else
  info "Skipping CometAPI test (--skip-cometapi)"
fi

# ─────────────────────────────────────────────────────────────────────────────
step "PHASE 9 — Final summary"
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "Finished: $(date)"
[[ -n "${ANTHROPIC_RUN_ID:-}" ]] && info "Anthropic run ID : ${ANTHROPIC_RUN_ID}"
[[ -n "${COMETAPI_RUN_ID:-}"  ]] && info "CometAPI  run ID : ${COMETAPI_RUN_ID}"
echo ""
echo "================================================================"
printf "  ✅ PASSED : %d\n" "$PASS"
printf "  ❌ FAILED : %d\n" "$FAIL"
printf "  ⚠️  WARNED : %d\n" "$WARN"
printf "  TOTAL    : %d\n"  "$((PASS+FAIL+WARN))"
echo "================================================================"

if [[ $FAIL -gt 0 ]]; then
  echo -e "\n${RED}Failed checks:${NC}"
  for err in "${ERRORS[@]}"; do
    echo -e "  ${RED}✗${NC} $err"
  done
  echo ""
  echo "  For app logs: tail -100 ${TMP_LOG}"
fi

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}✅  Fresh installation passes all checks.${NC}"
else
  echo -e "${RED}${BOLD}❌  Fresh installation FAILED (${FAIL} checks).${NC}"
fi
echo ""

exit $FAIL

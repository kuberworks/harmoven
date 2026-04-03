#!/usr/bin/env bash
# quickstart.sh — Harmoven one-command setup
# Usage: bash quickstart.sh
#
# What this script does:
#   1. Checks prerequisites (Docker, openssl)
#   2. Generates .env with random secrets (if .env does not exist)
#   3. Prompts for an LLM API key
#   4. Starts Harmoven with docker compose
#
# To restart without regenerating secrets:
#   docker compose up -d

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
error() { echo -e "${RED}✗ $*${NC}" >&2; }
step()  { echo -e "\n${BOLD}$*${NC}"; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
step "Checking prerequisites..."

command -v docker >/dev/null 2>&1   || { error "Docker is required → https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { error "Docker Compose v2 is required → https://docs.docker.com/compose/install/"; exit 1; }
command -v openssl >/dev/null 2>&1  || { error "openssl is required (usually pre-installed on macOS/Linux)."; exit 1; }

info "Docker $(docker --version | grep -o '[0-9.]*' | head -1)"
info "Docker Compose $(docker compose version --short)"

# ── .env generation ───────────────────────────────────────────────────────────
step "Configuring environment..."

if [ -f .env ]; then
  warn ".env already exists — skipping secret generation. Delete .env to regenerate."
else
  info "Generating .env with random secrets..."

  POSTGRES_PASS=$(openssl rand -hex 24)
  AUTH_SECRET_VAL=$(openssl rand -base64 32)
  ENC_KEY_VAL=$(openssl rand -base64 32)

  cp .env.example .env

  # Use python3 for portable in-place substitution (macOS + Linux compatible)
  POSTGRES_PASS="$POSTGRES_PASS" \
  AUTH_SECRET_VAL="$AUTH_SECRET_VAL" \
  ENC_KEY_VAL="$ENC_KEY_VAL" \
  python3 << 'PYEOF'
import re, os

content = open('.env').read()
pg   = os.environ['POSTGRES_PASS']
auth = os.environ['AUTH_SECRET_VAL']
enc  = os.environ['ENC_KEY_VAL']

# DATABASE_URL: switch localhost → db (Docker internal hostname) + inject password
content = content.replace(
    'DATABASE_URL="postgresql://harmoven:CHANGE_ME@localhost:5432/harmoven"',
    f'DATABASE_URL="postgresql://harmoven:{pg}@db:5432/harmoven"',
)
# Comment out the "internal URL" hint (it's now the active value)
content = content.replace(
    '# DATABASE_URL="postgresql://harmoven:CHANGE_ME@db:5432/harmoven"',
    '# DATABASE_URL="postgresql://harmoven:...@db:5432/harmoven"  # ← already set above',
)
content = re.sub(r'POSTGRES_PASSWORD="CHANGE_ME"\s*#[^\n]*', f'POSTGRES_PASSWORD="{pg}"', content)
content = re.sub(r'AUTH_SECRET=""\s*#[^\n]*', f'AUTH_SECRET="{auth}"', content)
content = re.sub(r'ENCRYPTION_KEY=""\s*#[^\n]*', f'ENCRYPTION_KEY="{enc}"', content)

open('.env', 'w').write(content)
PYEOF

  info "POSTGRES_PASSWORD generated"
  info "AUTH_SECRET generated"
  info "ENCRYPTION_KEY generated"
fi

# ── LLM API key ───────────────────────────────────────────────────────────────
# Check if any LLM key is already set in .env
HAS_LLM_KEY=false
for key in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_AI_API_KEY MISTRAL_API_KEY; do
  val=$(grep "^${key}=" .env 2>/dev/null | cut -d'=' -f2- | tr -d '"' || true)
  if [ -n "$val" ] && [ "$val" != '""' ]; then
    HAS_LLM_KEY=true
    info "$key is set"
    break
  fi
done

if [ "$HAS_LLM_KEY" = "false" ]; then
  step "LLM provider setup"
  echo "Harmoven needs at least one LLM provider to run pipelines."
  echo ""
  echo "  1) Anthropic (Claude) — https://console.anthropic.com"
  echo "  2) OpenAI  (GPT-4)   — https://platform.openai.com/api-keys"
  echo "  3) Google  (Gemini)  — https://aistudio.google.com/app/apikey"
  echo "  4) Skip for now      (you can set a key in .env later)"
  echo ""
  read -rp "Choose [1-4]: " LLM_CHOICE

  case "$LLM_CHOICE" in
    1)
      read -rp "Anthropic API key (sk-ant-...): " API_KEY
      sed -i.bak "s|ANTHROPIC_API_KEY=\"\"|ANTHROPIC_API_KEY=\"${API_KEY}\"|" .env && rm -f .env.bak
      info "Anthropic key saved"
      ;;
    2)
      read -rp "OpenAI API key (sk-...): " API_KEY
      sed -i.bak "s|OPENAI_API_KEY=\"\"|OPENAI_API_KEY=\"${API_KEY}\"|" .env && rm -f .env.bak
      info "OpenAI key saved"
      ;;
    3)
      read -rp "Google AI API key: " API_KEY
      sed -i.bak "s|GOOGLE_AI_API_KEY=\"\"|GOOGLE_AI_API_KEY=\"${API_KEY}\"|" .env && rm -f .env.bak
      info "Google AI key saved"
      ;;
    4)
      warn "No LLM key set. Harmoven will start but pipelines won't run until you add a key to .env."
      ;;
    *)
      warn "Invalid choice — skipping. Add an LLM key to .env before running pipelines."
      ;;
  esac
fi

# ── Start ─────────────────────────────────────────────────────────────────────
step "Starting Harmoven..."
docker compose up -d --build

# ── Health check ──────────────────────────────────────────────────────────────
step "Waiting for Harmoven to be ready..."
PORT=$(grep '^HARMOVEN_PORT=' .env 2>/dev/null | cut -d'=' -f2 || echo "3000")
PORT="${PORT:-3000}"
URL="http://localhost:${PORT}"

ATTEMPTS=0
MAX=40
until curl -sf "${URL}/api/health" >/dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX" ]; then
    error "Harmoven did not become healthy in time."
    echo "Check logs with: docker compose logs app"
    exit 1
  fi
  printf '.'
  sleep 3
done
echo ""
info "Harmoven is healthy"

# ── Setup token ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD} Harmoven is running at ${URL}${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Next steps:"
echo "  1. Retrieve the setup token:"
echo "       docker compose logs app | grep -i 'setup token'"
echo ""
echo "  2. Open ${URL}/setup and complete the wizard"
echo "       (admin account + organisation name + LLM profile)"
echo ""
echo "  3. To stop:   docker compose down"
echo "     To update: git pull && docker compose up -d --build"
echo ""

# Harmoven

**Self-hosted AI agent orchestration platform.** Describe a business goal in plain language — Harmoven runs it through a graph of specialised AI agents (Classifier → Planner → Writer → Reviewer → Critical Reviewer), enforces human-gate approvals at any checkpoint, tracks every token and dollar, and exposes the full flow over a versioned REST API.

Deploy in minutes on Docker Compose. Built for teams that need data sovereignty and cannot send sensitive content to third-party SaaS services.

---

## What it does

| Feature | Detail |
|---|---|
| **Multi-agent DAG pipeline** | Agents execute as a Directed Acyclic Graph — CLASSIFIER → PLANNER → WRITER → REVIEWER → CRITICAL REVIEWER, with parallelism at each level |
| **Human-in-the-loop gates** | Pause any run at a defined node for human approval, partial edit, or replay before continuing |
| **Multi-LLM routing** | Per-node model selection driven by confidentiality level, jurisdiction tags, context-window fit, and remaining budget |
| **Visual pipeline builder** | Drag-and-drop DAG editor (React Flow) to create and save reusable pipeline templates per project |
| **RBAC** | 7 built-in roles, 27 atomic permissions, per-project membership — enforced at API and UI layer |
| **Immutable audit log** | PostgreSQL-level log; UPDATE and DELETE are blocked by DB rules |
| **Real-time SSE streaming** | Live run events (node start/complete, cost updates, gate opens) streamed to the browser |
| **Context injection** | Inject additional context into a running pipeline mid-execution without restarting |
| **Marketplace** | Install domain skill packs (official registry or Git/local) to extend agent capabilities |
| **Analytics dashboard** | KPI board: runs completed, gate decisions, cost over time, ROI estimate |
| **Config GitOps** | `orchestrator.yaml` auto-versioned in a local git mirror on every change |
| **Auto-updates** | Background update check with digest verification and supply-chain hardening |
| **i18n** | English and French, switchable per user; instance-wide default in `orchestrator.yaml` |
| **Adaptive UI levels** | GUIDED / STANDARD / ADVANCED — interface complexity adapts to user experience score |
| **Electron desktop mode** | Single-user offline mode; SQLite replaces PostgreSQL automatically |

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router, Server Components) |
| Language | TypeScript 5 |
| Database | PostgreSQL 16 via Prisma ORM |
| Auth | Better Auth 1.5+ — TOTP + Passkey MFA |
| UI | Tailwind CSS, Radix UI, Lucide icons |
| Pipeline editor | React Flow (`@xyflow/react`) |
| LLM providers | Anthropic, OpenAI, Google Gemini, LiteLLM gateway (opt-in), CometAPI (opt-in) |
| MCP skills | Model Context Protocol SDK 1.28 |
| Deployment | Docker Compose / Electron |

---

## Requirements

| Dependency | Minimum version | Notes |
|---|---|---|
| Docker + Docker Compose | v2 | Required for Docker install |
| Node.js | 22 | Only for local dev (not needed with Docker) |
| PostgreSQL | 16 | Bundled in Docker Compose |
| LLM API key | — | Anthropic, OpenAI, Gemini, or Mistral |

---

## Quick start (Docker Compose)

### One-command setup (recommended)

```bash
git clone https://github.com/your-org/harmoven.git
cd harmoven
bash quickstart.sh
```

`quickstart.sh` handles everything: generates `.env` with random secrets, prompts for an LLM API key, builds and starts the containers, waits for the health check, and prints the setup URL.

---

### Manual setup

If you prefer to configure things yourself:

#### 1. Configure

```bash
git clone https://github.com/your-org/harmoven.git
cd harmoven
cp .env.example .env
```

Edit `.env` — fill in the mandatory secrets:

```bash
DATABASE_URL=postgresql://harmoven:CHANGE_ME@db:5432/harmoven   # use 'db', not 'localhost'
POSTGRES_PASSWORD=CHANGE_ME          # must match the password in DATABASE_URL
AUTH_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)
ANTHROPIC_API_KEY=sk-ant-...         # or OPENAI_API_KEY / GOOGLE_AI_API_KEY
```

> All variables are documented inline in `.env.example`. Never commit `.env`.

#### 2. Start

```bash
docker compose up -d
```

The app builds the image, starts PostgreSQL, and runs `prisma migrate deploy` automatically before serving traffic. The app starts at **http://localhost:3000**.

On first boot a **setup token** is printed in the logs. Open `/setup`, enter the token, and complete the wizard (admin account + LLM profile + organisation preset).

```bash
docker compose logs app | grep -i "setup token"
```

#### 3. Verify

```bash
curl http://localhost:3000/api/health
# → {"status":"ok"}
```

#### Port conflicts

If port 3000 or 5432 is already in use, add to `.env`:

```bash
HARMOVEN_PORT=3001
AUTH_URL="http://localhost:3001"   # must match HARMOVEN_PORT
HARMOVEN_DB_PORT=5433
```

---

## Development setup (local, no Docker)

```bash
npm install

# Start only the database via Docker
docker compose up db -d
cp .env.example .env   # point DATABASE_URL to localhost:5432

# Apply migrations (also regenerates the Prisma client)
npm run db:migrate

# Start the dev server
CONFIG_GIT_DIR=/tmp/harmoven-config-git npm run dev
```

> `CONFIG_GIT_DIR` tells the config-git module where to store the local git mirror of `orchestrator.yaml`. Any writable path works during development.

---

## Configuration

Two files drive runtime behaviour — both live in version control (zero secrets in either):

| File | Purpose |
|---|---|
| `orchestrator.yaml` | Org name, preset, LLM profiles, security policy, rate limits, marketplace registry |
| `.env` | Secrets only (DATABASE_URL, AUTH_SECRET, API keys) — never committed |

### Organisation presets (`organization.preset`)

| Preset | Profile |
|---|---|
| `small_business` | Low concurrency, $10/day auto-run cost cap, in-memory rate limiter |
| `enterprise` | Higher concurrency, Upstash rate limiter, Presidio PII detection opt-in |
| `developer` | Relaxed limits, MFA optional for non-admins |

### LLM profiles

Three tiers ship out of the box (mapped in `orchestrator.yaml → llm.profiles_active`):

| Tier | Default model | Typical use |
|---|---|---|
| `fast` | Claude Haiku | CLASSIFIER, simple routing |
| `balanced` | Claude Sonnet | PLANNER, WRITER |
| `powerful` | Claude Opus | REVIEWER, CRITICAL REVIEWER |

The LLM selector applies hard constraints before scoring: confidentiality level (`CRITICAL` → local model only), jurisdiction tags (`eu_only`, `no_cn_jurisdiction`, `local_only`), and context-window fit.

---

## Optional: LiteLLM gateway (multi-provider routing)

Route to OpenAI, Mistral, Gemini, or local models alongside Anthropic:

```bash
# Find the current pinned digest first
docker pull ghcr.io/berriai/litellm:main-v1.82.6
docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/berriai/litellm:main-v1.82.6

# Start with digest pinning
LITELLM_DIGEST=sha256:<digest> docker compose --profile litellm up -d
```

Then set `litellm.enabled: true` in `orchestrator.yaml`. The app calls `http://litellm:4000` — raw provider keys are never exposed to the app container.

---

## npm scripts

```bash
npm run dev              # Local dev server (Next.js)
npm run build            # Production build
npm run test             # All tests (unit + integration)
npm run test:unit        # Unit tests only (mock LLM tier)
npm run test:integration # Integration tests (requires live DB)
npm run test:e2e         # E2E tests (Playwright)
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run db:migrate       # Apply pending Prisma migrations
npm run db:seed          # Seed DB with demo data
npm run db:studio        # Open Prisma Studio
npm run generate:openapi # Regenerate openapi/v1.yaml
```

---

## REST API

Full spec: [`openapi/v1.yaml`](openapi/v1.yaml)

Base URL: `http://localhost:3000/api/v1`

Authentication: `Authorization: Bearer hv1_<32 hex chars>` — generate a key in **Project Settings → API Keys**.

Key endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/runs` | Submit a task, start a pipeline run |
| `GET` | `/v1/runs/:id` | Run status, node outputs, cost |
| `GET` | `/v1/runs/:id/stream` | SSE stream of all run events |
| `DELETE` | `/v1/runs/:id` | Abort a running pipeline |
| `POST` | `/v1/runs/:id/gate` | Approve or reject a human gate |
| `GET` | `/v1/projects` | List accessible projects |
| `GET` | `/api/analytics` | KPI board data (admin / project admin) |

Rate limit: **60 requests / minute per API key**. Excess returns HTTP 429 with `Retry-After`.

---

## Architecture

```
Browser / API client
        │
        ▼
  Next.js 15 App Router
  (Server Components + API routes)
        │
        ▼
  Execution Engine  (lib/execution/)
  ┌──────────────────────────────────────────┐
  │  DAG executor (custom / Temporal / Restate)│
  │  CLASSIFIER → PLANNER → WRITER           │
  │           ↘ REVIEWER → CRITICAL REVIEWER │
  │  HumanGate  (pause / inject / replay)    │
  │  Budget guard · heartbeat watchdog       │
  └──────────────────────────────────────────┘
        │
        ▼
  LLM Router  (lib/llm/)
  ┌──────────────────────────────────────────┐
  │  selectLlm(confidentiality, jurisdiction,│
  │            tokens, budget)               │
  │  → Anthropic direct                      │
  │  → OpenAI / Gemini / CometAPI            │
  │  → LiteLLM gateway sidecar (opt-in)      │
  └──────────────────────────────────────────┘
        │
        ▼
  PostgreSQL 16  (Prisma ORM)
  ┌──────────────────────────────────────────┐
  │  Projects · Runs · Nodes · Handoffs      │
  │  AuditLog (immutable, DB-enforced)       │
  │  ProjectMember · RBAC · API keys         │
  │  MCP skills · Pipeline templates         │
  └──────────────────────────────────────────┘
```

---

## Permission model

27 permissions are organised into 7 built-in roles with additive inheritance:

`viewer` ⊂ `operator` ⊂ `user` ⊂ `user_with_costs` ⊂ `developer` ⊂ `admin` ⊂ `instance_admin`

Custom roles can extend any built-in role. Roles are scoped per project; a user can be `admin` in one project and `viewer` in another.

---

## Security highlights

- Argon2id password hashing; timing-safe API key comparison
- MFA (TOTP or Passkey) enforced for all `instance_admin` accounts
- SSRF protection: DNS + private IP block on all outbound agent calls, fails closed
- CSP without `unsafe-eval` in production; HSTS 2 years
- Docker images and marketplace packs pinned by SHA-256 digest
- Immutable audit log (PostgreSQL UPDATE/DELETE blocked at DB level)
- Sign-in rate limit: 5 attempts / IP / 15 min; API key limit: 60 req / min
- Zero secrets in Docker images or `orchestrator.yaml`
- Cosign image verification (opt-in via `orchestrator.yaml → security.supply_chain`)

See [`.specs/analysis/architecture-review.md`](.specs/analysis/architecture-review.md) for the full security audit.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/setup` blank page | Setup token not printed yet | `docker compose logs app \| grep "setup token"` |
| `PrismaClientInitializationError` | DB not ready | `docker compose up db -d`, wait 10 s, restart app |
| `AUTH_SECRET` error on startup | Missing or too-short secret | `openssl rand -base64 32` → paste into `.env` |
| Dev server crashes immediately | `CONFIG_GIT_DIR` not set | Prefix with `CONFIG_GIT_DIR=/tmp/hv-cfg npm run dev` |
| LLM calls fail with 401 | Wrong or trailing-space API key | Verify `ANTHROPIC_API_KEY` in `.env` |
| Gate never resolves | Gate timeout expired | Check `orchestrator.yaml → execution_engine` timeout settings |

---

## Contributing

Branch naming: `feat/*`, `fix/*`, `docs/*`. All PRs target `develop`.

---

## License

CC BY-NC 4.0 — see [`LICENSE`](LICENSE).

Additional commands useful before creating a task:

- [/sdd:create-ideas](create-ideas.md) - Generate diverse ideas on a given topic using creative sampling techniques
- [/sdd:brainstorm](brainstorm.md) - Refine vague ideas into fully-formed designs through collaborative dialogue

## Available Agents

The SDD plugin uses specialized agents for different phases of development:

| Agent | Description | Used By |
|-------|-------------|---------|
| `researcher` | Technology research, dependency analysis, best practices | `/sdd:plan` (Phase 2a) |
| `code-explorer` | Codebase analysis, pattern identification, architecture mapping | `/sdd:plan` (Phase 2b) |
| `business-analyst` | Requirements discovery, stakeholder analysis, specification writing | `/sdd:plan` (Phase 2c) |
| `software-architect` | Architecture design, component design, implementation planning | `/sdd:plan` (Phase 3) |
| `tech-lead` | Task decomposition, dependency mapping, risk analysis | `/sdd:plan` (Phase 4) |
| `team-lead` | Step parallelization, agent assignment, execution planning | `/sdd:plan` (Phase 5) |
| `qa-engineer` | Verification rubrics, quality gates, LLM-as-Judge definitions | `/sdd:plan` (Phase 6) |
| `developer` | Code implementation, TDD execution, quality review, verification | `/sdd:implement` |
| `tech-writer` | Technical documentation, API guides, architecture updates, and lessons learned | `/sdd:implement` |

## Patterns

Key patterns implemented in this plugin:

- **Structured reasoning templates** — Includes Zero-shot and Few-shot Chain of Thought, Tree of Thoughts, Problem Decomposition, and Self-Critique. Each is tailored to a specific agent and task, enabling sufficiently detailed decomposition so that isolated sub-agents can implement each step independently.
- **Multi-agent orchestration for context management** — Context isolation of independent agents prevents "context rot," maintaining optimal LLM performance at each step. The main agent acts as an orchestrator that launches sub-agents and manages their workflow.
- **Quality gates based on LLM-as-Judge** — Evaluates the quality of each planning and implementation step using evidence-based scoring and predefined verification rubrics. This eliminates cases where an agent produces non-functional or incorrect solutions.
- **Continuous learning** — Automatically builds specific skills the agent needs to implement a task, which it might otherwise be unable to perform from scratch.
- **Spec-driven development pattern** — Based on the arc42 specification standard adjusted for LLM capabilities, this pattern eliminates elements of the specification that do not add value to implementation quality.
- **MAKER** — An agent reliability pattern introduced in [Solving a Million-Step LLM Task with Zero Errors](https://arxiv.org/abs/2511.09030). It minimizes agent mistakes caused by context accumulation and hallucinations by utilizing clean-state agent launches, filesystem-based memory storage, and multi-agent voting during critical decisions.

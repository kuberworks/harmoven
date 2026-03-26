---
title: Implement Harmoven v1 — Backend, API & Infrastructure (no frontend)
depends_on: []
created: 2026-03-25
status: todo
agents_completed: [researcher, code-explorer, business-analyst, software-architect, tech-lead, team-lead, qa-engineer]
agents_pending: []
---

## Initial User Prompt

Implement Harmoven v1 backend: Docker + Prisma + Auth + DAG Executor +
API routes + Human Gate logic + Admin + SSE events — per technical specs.
OUT OF SCOPE: no React/Next.js components, no UI pages, no CSS.
IN SCOPE: everything the frontend will need (shared TypeScript types,
typed API routes, SSE contracts, Prisma schema, RBAC middleware, seed data).

---

## Research Findings

### Confirmed stack

#### Runtime & Framework
| Package | Version | Role |
|---|---|---|
| `next` | 14+ | App Router, API routes, SSE via ReadableStream |
| `typescript` | strict mode | Strict typing throughout |
| `prisma` | latest | ORM — PostgreSQL (Docker) / SQLite (Electron) |
| `@prisma/client` | latest | Generated client |
| `better-auth` | **≥1.3.26** | Auth — DB sessions, Argon2id, TOTP, Passkeys, API keys |
| `zod` | latest | Schema validation — handoffs, API inputs, config |
| `node-cron` | latest | Cron trigger scheduling |
| `chokidar` | latest | File watcher triggers |
| `@modelcontextprotocol/sdk` | latest | MCP client |
| `jose` | latest | JWT signing/verification (webhook validation only) |
| `lru-cache` | latest | Rate limiting in-memory fallback (Electron) |
| `jszip` | latest | ZIP bomb detection on docx/xlsx uploads |

#### Optional services (opt-in via orchestrator.yaml)
| Package | License | Role |
|---|---|---|
| `temporal` SDK | MIT | Enterprise execution engine |
| `restate` SDK | Apache 2.0 | Electron execution engine |
| `litellm` | MIT | Unified LLM proxy — 100+ providers (Docker sidecar) |
| `microsoft/presidio` | MIT | Advanced PII detection |
| `n8n-mcp` | AGPL-3.0 | External webhook source (external only) |
| `@upstash/ratelimit` | MIT | Redis-backed rate limiting (fallback: lru-cache) |

#### NOT required (explicit confirmation)
- LangChain / LangGraph / LangSmith
- Redis / BullMQ (optional only if Upstash rate limiting enabled)
- Any vector database (pgvector optional enterprise memory)
- Separate security middleware (CSP/HSTS/CORS in next.config.js)

### Critical libraries to study

#### Better Auth ≥1.3.26
- **Required plugins**: `totp`, `passkey`, `apiKey`, `admin`
- **Adapter**: `prismaAdapter` — supports `postgresql` AND `sqlite` (switch via `DATABASE_PROVIDER` env var)
- **Bootstrap exception**: first admin created with `emailVerified: new Date()` directly (Setup Wizard)
- **Session**: cookie cache DISABLED — instant force-revocation
- **Passkeys**: `rpId = process.env.AUTH_DOMAIN ?? 'localhost'`
- **Argon2id**: 65536 KB (Docker) / 19456 KB (Electron) — or `ARGON2_MEMORY_KB` env var
- **Schema generation**: `npx @better-auth/cli generate` → `better-auth.prisma` → manual merge
- **⚠️ CVE-2025-61928**: fix included in ≥1.3.26 — strict pinning mandatory

#### Prisma + Migrations
- **`down.sql` convention**: mandatory on every migration (Am.84) — CI blocks without it
- **Dual-write**: `ProjectRole enum → model` migration (Am.78) requires a smooth transition
- **Immutable audit log**: UPDATE/DELETE blocked by DB rules in the migration
- **EventPayload**: present from day 1 for SSE reconnect buffer (Am.79)
- **RunActorStats**: present but `experimental.actor_stats.enabled = false` by default (Am.80)

#### DAG Executor (Custom)
- **Interface**: `IExecutionEngine` (Am.82.5) — never call implementations directly
- **State machine**: PENDING → RUNNING → COMPLETED | FAILED | SUSPENDED | PAUSED
- **Parallelism**: `Promise.all` on READY nodes — `MAX_CONCURRENT_NODES` from `orchestrator.yaml`
- **Heartbeat**: every 30s on RUNNING nodes
- **Orphan detection**: nodes with stale heartbeat → FAILED
- **Crash recovery**: SIGTERM handler + resume RUNNING runs on startup (Am.34.3b)
- **Streaming**: `stream: true` + `AbortController` propagated — `partial_output` flushed every 5s

#### IProjectEventBus (Am.79)
- **Implementations**: `PgNotifyEventBus` (Docker) / `InMemoryEventBus` (Electron/tests)
- **Factory**: `DEPLOYMENT_MODE` env var at startup
- **EventPayload**: DB table for reconnect buffer (30s)
- **SSE filtering**: by permission (Am.78.6)

#### MCP Protocol
- `@modelcontextprotocol/sdk` wrapped in `lib/mcp/client.ts`
- Pre-approved skills: n8n-MCP, UI UX Pro Max, ECC AgentShield, Superpowers, MegaMemory
- SHA256 verified at startup (Am.91)

#### Security (Am.92/93)
- `execFile()` + `assertSafe*()` — never `exec()` with template literals
- `safeBaseEnv()` whitelist — never raw `...process.env`
- `assertNotPrivateHost()` on all custom LLM base URLs (SSRF)
- Tecnativa Docker socket proxy (docker-compose.yml)
- `timingSafeEqual()` for API key comparison
- `gitleaks` on generated worktrees
- `release-pins.yaml` + 3-layer update verification (digest + SHA + Cosign)

### Identified technical risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Complex Better Auth schema merge | High | Medium | Follow Am.46.E exactly — CLI generate + manual merge |
| Prisma migrations missing `down.sql` | Medium | High | Blocking CI check (Am.84) — `scripts/verify-migration-baseline.js` |
| SSE scaling single-instance | Medium | Medium | `InMemoryEventBus` for dev, `PgNotifyEventBus` for Docker |
| Passkeys FIDO2 localhost | High | Low | `rpId = 'localhost'` in dev — `AUTH_DOMAIN` in prod |
| `ProjectRole` dual-write migration | High | High | Keep enum column during transition (Am.78) |
| Argon2id memory on Electron | Medium | Medium | `ARGON2_MEMORY_KB` env var or auto-detect `DEPLOYMENT_MODE` |
| `EventPayload` table bloat | Low | Low | Cron purge >24h — in migration seed |
| Credential vault key co-location | High | Critical | `ENCRYPTION_KEY` NEVER co-located with `DATABASE_URL` |
| SSRF via custom LLM URLs | Medium | Critical | `assertNotPrivateHost()` mandatory before any fetch |
| Prompt injection | Medium | High | Defense layer in Classifier (Sections 24 AGENTS-02) |

### Useful references

| Domain | Reference |
|---|---|
| Full stack | TECHNICAL.md Section 2 |
| Complete Prisma schema | TECHNICAL.md Section 3 |
| Internal API routes | TECHNICAL.md Section 4 |
| Public API routes v1 | TECHNICAL.md Section 4B |
| DAG Executor | TECHNICAL.md Section 5, Amendment 82 |
| LLM Routing | TECHNICAL.md Sections 6, 7 |
| Auth Better Auth | TECHNICAL.md Section 8 |
| Environment variables | TECHNICAL.md Section 10 |
| IProjectEventBus | TECHNICAL.md Section 29, Amendment 79 |
| RBAC 27 permissions | TECHNICAL.md Section 28, Amendment 78 |
| Config GitOps | TECHNICAL.md Section 32, Amendment 83 |
| Supply chain security | TECHNICAL.md Sections 39–42, Amendments 91–93 |
| Recommended build order | V1_SCOPE.md — Recommended build order (v7.55) |
| v1 architectural constraints | V1_SCOPE.md — Architectural constraints |
| Detailed tasks | TASKS.md (T1.1 → T3.9) |
| Enterprise sandbox | ENTERPRISE.md Section 1 |
| Optimizer canary | ENTERPRISE.md Section 2 |
| LLM agent profiles | AGENTS-05-INFRASTRUCTURE.md (Extension profiles) |

### Researcher score: 4.5/5

Unresolved (minor):
- Exact npm versions not pinned — `package.json` does not exist yet, to be resolved in T1.1
- Full `orchestrator.yaml` schema not documented in specs — to be inferred from TECHNICAL.md Section 9
- `DEPLOYMENT_MODE` env var: exact values (`docker` | `electron`) to confirm at implementation time

---

## Description

Harmoven v1 is a self-hosted LLM agent orchestration platform,
deployable via Docker (PostgreSQL + Next.js) or Electron (local SQLite).

This scope covers **the backend exclusively**:
- Docker infrastructure (compose, env, orchestrator.yaml)
- Full Prisma schema + versioned migrations (with `down.sql`)
- Better Auth ≥1.3.26 authentication (DB sessions, Argon2id, TOTP, Passkeys, API keys)
- Custom DAG Executor (state machine, parallelism, heartbeat, orphan detection, crash recovery)
- Core agents: Intent Classifier, Planner, Writer, Standard Reviewer
- IProjectEventBus + SSE live events (per run + per project)
- Fine-grained RBAC (27 permissions, 7 built-in roles, ProjectRole model, ProjectApiKey)
- Internal API routes (`/api/**`) and public API v1 (`/api/v1/**`)
- Shared TypeScript types (contracts for the frontend)
- Credential management (AES-256-GCM, write-only, scoped)
- Immutable audit log
- Config GitOps (`config.git`)
- Supply chain security + hardening Am.92/93
- CI/CD GitHub Actions (3 levels)
- i18n en + fr

**OUT OF SCOPE**: no React/Next.js components, no UI pages (`app/(app)/`, `app/(auth)/`),
no CSS, no React hooks, no Playwright/Cypress tests.

**Backend deliverables for the frontend**: `types/api.ts` (generated from `openapi/v1.yaml` via `openapi-typescript` — never edited by hand), `types/events.ts`, `types/run.ts`,
`types/auth.ts`, `lib/auth/rbac.ts` (Permission enum importable client-side),
`openapi/v1.yaml` (canonical public API spec, extracted from TECHNICAL.md §4B.6).

---

## Acceptance Criteria

### Infrastructure & Docker

- [ ] `docker compose up --build` starts Next.js on `:3000` and PostgreSQL on `:5432` on a fresh machine (no local dependencies)
- [ ] `.env.example` documents all required variables with explanatory comments
- [ ] `.env.test` configured and usable in CI (MockLLMClient by default)
- [ ] `orchestrator.yaml` present and loaded at startup
- [ ] All Docker services pass their healthcheck
- [ ] `npm run build` compiles without error in `DATABASE_PROVIDER=postgresql` mode

### Prisma & Database

- [ ] `npx prisma migrate deploy` succeeds on an empty DB
- [ ] `down.sql` present in every migration directory (CI blocks if missing)
- [ ] All models present: `Project`, `Run`, `Node`, `Handoff`, `HumanGate`, `AuditLog`, `Trigger`, `LlmProfile`, `McpSkill`, `MemoryResource`, `ProjectMember`, `ProjectRole` (model, not enum), `ProjectApiKey`, `EventPayload`, `RunActorStats`, `EvalResult`, `ProjectCredential`, `OAuthToken`, `WebhookDelivery`, `UserPreference`, `InstalledPack`, `SourceTrustEvent`, `GitWorktree`
- [ ] Am.85 fields present on `Run`: `user_rating`, `estimated_hours_saved`, `task_input_chars`, `business_value_note`
- [ ] Am.86/87 fields present on `User`: `ui_locale`, `transparency_language`
- [ ] `RunStatus` enum: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `SUSPENDED`, `PAUSED`
- [ ] `NodeStatus` enum: `PENDING`, `RUNNING`, `BLOCKED`, `FAILED`, `ESCALATED`, `SKIPPED`, `COMPLETED`, `DEADLOCKED`, `INTERRUPTED`
- [ ] `Run` IDs = UUID v7 (no sequential integers — v2 federation constraint)
- [ ] Better Auth tables generated via `npx @better-auth/cli generate` and merged (never defined manually)
- [ ] `AuditLog`: UPDATE/DELETE blocked by DB rules in the migration (immutability guaranteed at DB level)

### Auth & Sessions

- [ ] `POST /api/auth/signin` → 200 with valid credentials (email + password)
- [ ] `POST /api/auth/signin` → 401 with wrong password
- [ ] Sign-in rate limiting: 5 attempts / 15 minutes per IP
- [ ] Magic link email sent and functional (Resend or SMTP)
- [ ] TOTP setup + verification functional
- [ ] Passkey registration + login end-to-end (`rpId = AUTH_DOMAIN`)
- [ ] Session cookie cache **disabled** (instant force-revocation)
- [ ] `auth.api.revokeUserSessions()` immediately revokes all sessions for a user
- [ ] Bootstrap exception: first admin created via Setup Wizard without email verification (`emailVerified: new Date()`)
- [ ] All subsequent accounts: email verification required
- [ ] Argon2id: 65536 KB in Docker mode, 19456 KB in Electron mode (or `ARGON2_MEMORY_KB` env var)
- [ ] `ProjectApiKey` format `hv1_{32 chars}`, comparison via `timingSafeEqual()`

### RBAC & Permissions

- [ ] 7 built-in roles seeded: `viewer`, `operator`, `user`, `user_with_costs`, `developer`, `admin`, `instance_admin`
- [ ] `resolvePermissions(session, projectId)` returns the correct `Set<Permission>`
- [ ] 27 permissions defined and enforced on API routes
- [ ] `ProjectRole` is a model (with nullable `project_id` for global roles), never a Prisma enum
- [ ] SSE events filtered by permission (Am.78.6): a `viewer` does not receive `cost_update` or `gate_opened` events
- [ ] IDOR enforcement: `assertRunAccess()` and `assertProjectAccess()` called at the top of every GET resource route

### DAG Executor

- [ ] `IExecutionEngine` interface (Am.82.5) implemented — factory `createExecutionEngine()` returns the correct implementation based on `DEPLOYMENT_MODE`
- [ ] `PENDING → RUNNING → COMPLETED` transition tested in unit tests with `MockLLMClient`
- [ ] `cancelRun()` stops all in-progress nodes cleanly (< 1s)
- [ ] `pauseRun()` + `resumeRun()`: state preserved, run resumes at the correct node
- [ ] Parallel nodes (same dependency level) executed via `Promise.all`
- [ ] `MAX_CONCURRENT_NODES` respected from `orchestrator.yaml`
- [ ] Heartbeat updated every 30s on `RUNNING` nodes
- [ ] Orphan detection: nodes with stale heartbeat → `FAILED` (unit test)
- [ ] Crash recovery: on startup, `RUNNING` runs are resumed (SIGTERM handler)
- [ ] `AbortController` propagated to every LLM call (streaming interruption functional)
- [ ] `partial_output` flushed to DB every 5s (not on every chunk)
- [ ] 5 test fixtures pass: `linear`, `parallel`, `branching`, `failed`, `paused`

### Core Agents

- [ ] `IntentClassifier`: produces `DomainProfile` + `confidence` (confidence < 80% → clarification gate)
- [ ] `Planner`: produces a valid DAG JSON from `task_input` — validated by `lib/dag/validate.ts` (schema + structure: cycles, orphans, depth ≤ 4, terminal = reviewer)
- [ ] Planner retry: max 3 re-runs on validation failure → Human Gate if still invalid
- [ ] `Writer`: produces content via `IAgentRunner`, streaming functional
- [ ] `StandardReviewer`: produces `ReviewResult` with findings (distinct from `CriticalReviewer`)
- [ ] DAG: terminal node always of type `reviewer`
- [ ] DAG: `scope_notes` documented when scope is reduced due to budget

### Human Gate

- [ ] Gate created automatically when a node requires it (based on `supervision_mode`)
- [ ] `HumanGate.status` cycle: `OPEN → RESOLVED` or `TIMED_OUT`
- [ ] Supported decisions: `approve`, `modify`, `replay_node`, `abort`
- [ ] `POST /api/runs/:runId/gate`: `gates:write` permission verified before processing
- [ ] SSE `human_gate` notification sent on every gate open
- [ ] Interrupt Gate (Am.65): 3 decisions — `resume_from_partial`, `replay_from_scratch`, `accept_partial`
- [ ] Gate timeout: `timeout_at` set, `TIMED_OUT` state after expiry

### API & Security

- [ ] All routes: session check first, before any operation
- [ ] All GET resource routes: `assertRunAccess()` or `assertProjectAccess()` before DB query
- [ ] All POST routes: Zod `.strict()` validation before business logic
- [ ] Every write: `AuditLog` entry (actor, action, payload diff)
- [ ] Rate limit: `POST /api/runs` → 10/min; `POST /api/auth/signin` → 5/15min
- [ ] `GET /api/admin/credentials`: never return `value_enc` or decrypted value
- [ ] IDOR: `GET /api/runs/:id` for a project the user is not a member of → 403
- [ ] `npm audit` → 0 critical vulnerabilities
- [ ] Dependency pinning: CI actions pinned by commit SHA (not tag) in `.github/workflows/`
- [ ] `assertNotPrivateHost()` called on all custom LLM base URLs (SSRF protection)
- [ ] `execFile()` used everywhere — never `exec()` with template literals (ESLint rule active)
- [ ] `safeBaseEnv()` used in all child process contexts

### SSE & Event Bus

- [ ] `PgNotifyEventBus` functional in Docker mode
- [ ] `InMemoryEventBus` functional in Electron / test mode
- [ ] `createEventBus()` factory selects the implementation from `DEPLOYMENT_MODE`
- [ ] `GET /api/runs/:runId/stream`: SSE live events, `stream:state` permission required
- [ ] `GET /api/projects/:projectId/stream`: aggregated SSE (all project runs), `project:read` permission
- [ ] `EventPayload` stored in DB for reconnect buffer (30s)
- [ ] Integration test: client receives `state_change` event after node transition

### Frontend contracts (backend deliverables)

- [ ] `openapi/v1.yaml`: OpenAPI 3.1.0 spec extracted from TECHNICAL.md §4B.6, covers all `/api/v1/*` public routes
- [ ] `types/api.ts`: **generated** by `openapi-typescript` from `openapi/v1.yaml` — never edited by hand; `npm run generate:types` produces it
- [ ] `types/events.ts`: `RunSSEEvent` union type with all event types (`initial`, `state_change`, `cost_update`, `human_gate`, `budget_warning`, `llm_fallback`, `completed`, `error`)
- [ ] `types/run.ts`: `RunStatus`, `NodeStatus`, `HumanGateStatus`, `GateDecision` enums exported
- [ ] `lib/auth/rbac.ts`: `Permission` enum importable client-side
- [ ] CI check: `npm run generate:types && git diff --exit-code types/api.ts` — fails if implementation drifted from spec

### LLM Routing

- [ ] `DirectLLMClient` functional with Anthropic, OpenAI, Google Gemini
- [ ] Multi-criteria scorer: trust tier, jurisdiction, cost, confidentiality
- [ ] CometAPI connector (Am.71): OpenAI-compatible client with `baseURL = https://api.cometapi.com/v1`
- [ ] Ollama local: auto-detection
- [ ] `createLLMClient()` factory respects `orchestrator.yaml` config
- [ ] Confidentiality Classifier: NER + regex, local (no external LLM calls), blocks `cn` models on `HIGH`/`CRITICAL` data
- [ ] Integration test: full run with real Haiku (`HARMOVEN_LLM_TIER=haiku`)

### Admin

- [ ] `GET/POST /api/admin/models`: list and add LLM profiles
- [ ] `PATCH /api/admin/models/:id`: enable/disable/update profile
- [ ] `GET/POST /api/admin/skills`: list and install MCP skills (SHA256 scan on activation)
- [ ] `GET/POST/PATCH /api/admin/triggers`: manage triggers (cron, file watcher, webhook)
- [ ] `GET/POST/PATCH/DELETE /api/admin/credentials`: manage credentials (value write-only, never returned)
- [ ] `POST /api/webhooks/:projectId/:triggerId`: HMAC-SHA256 validation + timestamp freshness (< 5min) + delivery idempotency

### Code quality

- [ ] `npx tsc --noEmit` → 0 TypeScript errors (strict mode)
- [ ] `npm test` → all suites pass (unit + integration)
- [ ] `npm run build` → compiles without error
- [ ] MockLLMClient used in all unit tests (0 real LLM calls in CI)
- [ ] `scripts/verify-migration-baseline.js`: blocks if `down.sql` missing

---

## Out of Scope (this backend scope)

- All React components / Next.js pages (`app/(app)/**`, `app/(auth)/**`)
- CSS, Tailwind, design tokens, design system
- React hooks, frontend state management (Zustand, TanStack Query, etc.)
- Browser end-to-end tests (Playwright / Cypress)
- Kanban multi-run UI (T3.1) — SSE route ready, UI component = frontend sprint
- `components/` (DagView, NodeCard, HumanGateModal, etc.)

## Out of Scope (v1 product — reserved for v2)

- SaaS cloud (`app.harmoven.com`) — +RLS +Stripe, ~1 week from v1
- Multi-instance federation — A2A protocol not stable
- Air-gap preset (BitNet not supported on ARM Linux)
- GitHub Actions trigger — v2
- Harmoven CLI — after marketplace established
- Marketplace monetization — premium packs v2
- Kilo Cloud Agents — no stable public API (March 2026)
- Am.81 MCP server → stable — experimental, gate delegation not battle-tested

---

## Architecture Overview

### Key decisions

| Decision | Choice | Reason | Rejected alternative |
|---|---|---|---|
| **Event Bus** | `IProjectEventBus` → `PgNotifyEventBus` (Docker) / `InMemoryEventBus` (Electron) | PostgreSQL LISTEN/NOTIFY with no external dependency; zero infra for Electron | Redis Pub/Sub (extra dependency), BullMQ (overkill) |
| **Auth** | Better Auth ≥1.3.26 with `prismaAdapter` | Only lib with DB sessions + Argon2id + Passkeys + API keys in one coherent block. CVE-2025-61928 fixed in ≥1.3.26 | Auth.js v5 (abandoned by maintainer Jan 2025), NextAuth v4 (JWT sessions = no instant revocation) |
| **ORM** | Prisma with dual-provider `postgresql`/`sqlite` | Same schema for Docker and Electron via `DATABASE_PROVIDER` env var. Versioned migrations with mandatory `down.sql` | Drizzle ORM (less mature migrations in 2026), TypeORM (verbose) |
| **DAG Execution** | `IExecutionEngine` factory → `custom` by default | Zero external dependency for community. `temporal` (MIT) for enterprise Docker, `restate` (Apache 2.0) for Electron. Swappable without touching the app | LangGraph (framework imposing its state model, security audit not done), Inngest (SaaS only) |
| **LLM routing** | Multi-criteria scorer → `ILLMClient` factory | Routing by task affinity, cost, jurisdiction, confidentiality. `LiteLLMClient` opt-in as Docker sidecar — governance stays in the DAG Executor | LiteLLM as routing source of truth (loses budget and jurisdiction control) |
| **RBAC** | 27 permissions, 7 built-in roles, `ProjectRole` Prisma model | Fine granularity on SSE and Human Gate. `ProjectRole` as model (not enum) = custom roles per project. `resolvePermissions()` in one query, cached per request | Simple `role: 'admin'/'user'` (insufficient), CASL library (over-engineering for this scope) |
| **Code sandbox** | `docker run --network none --ignore-scripts --read-only --cap-drop ALL` | Blocks malicious npm hooks in generated code, isolates network, prevents exfiltration | Direct execution on host (CRITICAL: LLM code is untrusted), WASM VM (too much latency) |
| **Credentials** | AES-256-GCM vault in DB, `ENCRYPTION_KEY` separate from `DATABASE_URL` | Write-only: value never returned. Ephemeral token scope per run (Am.92) | Raw environment variables (readable by any compromised dependency), HashiCorp Vault (external dependency) |
| **Config versioning** | Local `config.git` (gitoxide / simple git) | Config rollback without DB rollback. Human-readable diff. No external service | DB storage only (no history, no diff), consul (external dependency) |
| **Supply chain** | `release-pins.yaml` + 3-layer (digest + commit SHA + Cosign) | Detects git tag rewrites (vector exploited against LiteLLM March 2026) | Tag alone (insufficient), digest alone (does not detect tag rewrite) |

---

### Application layers (backend scope only)

```
┌────────────────────────────────────────────────────────────────────┐
│  Frontend React (out of scope — future frontend sprint)            │
└──────────────────────┬─────────────────────────────────────────────┘
                       │  HTTP / SSE
┌──────────────────────▼─────────────────────────────────────────────┐
│  API Routes Next.js — app/api/**                                   │
│                                                                    │
│  middleware.ts                                                     │
│    ├─ Auth check       → auth.api.getSession() [Better Auth]       │
│    ├─ RBAC resolution  → resolvePermissions(session, project_id)   │
│    └─ Route guard      → assertRunAccess() / assertProjectAccess() │
│                                                                    │
│  /api/runs/**                                                      │
│    POST /api/runs              → createRun() → IExecutionEngine    │
│    GET  /api/runs/:id/stream   → SSE ReadableStream                │
│         ↑ subscribe to IProjectEventBus                           │
│         ↑ filterSSEEvent(event, perms) [Am.78.6]                  │
│    POST /api/runs/:id/gate     → resolveHumanGate()               │
│    POST /api/runs/:id/pause    → pauseRun()                        │
│    POST /api/runs/:id/resume   → resumeRun()                       │
│    POST /api/runs/:id/inject   → injectContext()                   │
│                                                                    │
│  /api/projects/**                                                  │
│    GET  /api/projects/:id/stream → SSE agrégé projet [Am.79]       │
│                                                                    │
│  /api/admin/**      → Admin handlers (models, skills, credentials) │
│  /api/webhooks/**   → HMAC-SHA256 + timestamp freshness + idempotency│
│  /api/v1/**         → Public API (bearer hv1_xxx authentication)   │
│  /api/auth/[...all] → toNextJsHandler(auth) [Better Auth]         │
└──────────┬─────────────────────────────────────────────────────────┘
           │
┌──────────▼─────────────────────────────────────────────────────────┐
│  IExecutionEngine — lib/execution/                                 │
│                                                                    │
│  factory: createExecutionEngine(config) → [custom | restate |     │
│           temporal | trigger_dev]                                  │
│                                                                    │
│  CustomExecutor (default)                                          │
│    ├─ executeRun() → Promise.all(getReadyNodes())                  │
│    ├─ executeNode() → selectLlm() → invokeAgent() → storeHandoff() │
│    ├─ startHeartbeat(node, 30s) + detectOrphans(threshold=5min)    │
│    ├─ SIGTERM handler → suspend + crash recovery au démarrage      │
│    └─ 5 fixtures test : linear, parallel, branching, failed, paused│
│                                                                    │
│  State machines :                                                  │
│    Node : PENDING → RUNNING → COMPLETED │ FAILED │ BLOCKED         │
│    Run  : PENDING → RUNNING → COMPLETED │ FAILED │ SUSPENDED       │
└──────────┬─────────────────────────────────────────────────────────┘
           │
┌──────────▼─────────────────────────────────────────────────────────┐
│  IAgentRunner — lib/agents/                                        │
│                                                                    │
│  factory: createAgentRunner(config) → [direct | mastra-stub]      │
│                                                                    │
│  DirectAgentRunner                                                 │
│    ├─ Agents core : IntentClassifier, Planner, Writer, Reviewer    │
│    ├─ Context optimizer : L2 scoping → L1 RTK → L4 fast compress  │
│    └─ ILLMClient.stream() + AbortSignal propagé                   │
└──────────┬─────────────────────────────────────────────────────────┘
           │
┌──────────▼─────────────────────────────────────────────────────────┐
│  ILLMClient — lib/llm/                                             │
│                                                                    │
│  factory: createLLMClient(config)                                  │
│    ├─ DirectLLMClient (default) → direct provider SDKs             │
│    └─ LiteLLMClient (opt-in)   → sidecar http://litellm:4000       │
│                                                                    │
│  Multi-criteria scorer (per-node selection):                      │
│    Affinité task_type (0-40pts) + coût (0-60pts) + préférence projet│
│    Filtres durs : confidentialité × juridiction × context window   │
└──────────┬─────────────────────────────────────────────────────────┘
           │
┌──────────▼─────────────────────────────────────────────────────────┐
│  IProjectEventBus — lib/events/                                    │
│                                                                    │
│  factory: createProjectEventBus() — DEPLOYMENT_MODE env var        │
│    ├─ PgNotifyEventBus  (Docker)   — canal harmoven:project:{id}   │
│    │   EventPayload table = reconnect buffer 30s + large events    │
│    ├─ InMemoryEventBus  (Electron) — EventEmitter, no persistence  │
│    └─ RestateEventBus   (opt-in)   — durable, full replay          │
│                                                                    │
│  DagExecutor.emit() → bus → filterSSEEvent(perms) → client SSE     │
└──────────┬─────────────────────────────────────────────────────────┘
           │
┌──────────▼─────────────────────────────────────────────────────────┐
│  Database — Prisma                                                 │
│                                                                    │
│  PostgreSQL (Docker)  — DATABASE_PROVIDER=postgresql               │
│  SQLite (Electron)    — DATABASE_PROVIDER=sqlite                   │
│                                                                    │
│  Migrations: prisma/migrations/{date}_{name}/                      │
│    migration.sql (generated) + down.sql (manual — CI blocks if absent)│
│  Seed: built-in roles (7), admin bootstrap, MCP skills defaults    │
│  AuditLog: UPDATE/DELETE blocked by DB rule (immutability)         │
└──────────┬─────────────────────────────────────────────────────────┘
           │
┌──────────▼─────────────────────────────────────────────────────────┐
│  Shared types — types/**                                           │
│                                                                    │
│  api.ts    → generated from openapi/v1.yaml (openapi-typescript)   │
│  events.ts → RunSSEEvent union type (8 event types)                │
│  run.ts    → RunStatus, NodeStatus enums                           │
│  auth.ts   → Session, User (inferred from Better Auth)             │
│  rbac.ts   → Permission enum (importable client-side)              │
└────────────────────────────────────────────────────────────────────┘
```

---

### Implementation strategy

> The canonical step-by-step decomposition (Steps 1–25) is in **`## Implementation Process`** below, which maps directly to TASKS.md (T1.1 → T3.9).
>
> High-level phase structure:
> - **Phase 1** (Steps 1–9): T1.1 → T1.9 — foundations (Docker, schema, auth, DAG, agents, EventBus, SSE, LLM routing)
> - **Phase 2A** (Steps 10–14): T2A.1 → T2A.4 — scaffolding track (preview, platform detection, Critical Reviewer, EvalAgent)
> - **Phase 2B** (Steps 15–16): T2B.1 → T2B.2 — quality track (fine-grained RBAC, Config GitOps)
> - **Phase 3** (Steps 17–25): T3.1 → T3.9 — integration + hardening

**Validation checkpoints** (human approval required, per TASKS.md):
- After T1.5 → DAG Executor demo: run a mock task end-to-end
- After T1.9 → first real LLM run with Haiku (`marketing_content` domain)
- After T2A.1 → preview cascade live: scaffold a Next.js app
- After T2B.1 → RBAC demo: 3 roles, different permission views
- After T3.5 → CI green on all checks
- Final → E2E: 5 `app_scaffolding` scenarios pass

---

### Impacted files (consolidated)

```
New (backend only — ~120 files):
  docker-compose.yml
  .env.example, .env.test
  orchestrator.yaml
  next.config.ts                          # HTTP security headers, runtime config
  prisma/
    schema.prisma                         # ~900 lines with all models
    migrations/{date}_init/               # migration.sql + down.sql
    migrations/{date}_add_rbac_am78/      # migration.sql + down.sql
    seed.ts                               # 7 built-in roles + admin bootstrap
  lib/
    auth.ts                               # Full Better Auth config
    db/client.ts                          # Prisma singleton
    execution/
      engine.interface.ts                 # IExecutionEngine (Am.82.5)
      custom/executor.ts                  # CustomExecutor
      custom/heartbeat.ts
      custom/orphan-detector.ts
      custom/crash-recovery.ts
    agents/
      agent-runner.interface.ts           # IAgentRunner
      runners/direct.runner.ts
      core/intent-classifier.ts
      core/planner.ts                     # + DAG validator
      core/writer.ts
      core/reviewer.ts
    llm/
      llm-client.interface.ts             # ILLMClient
      clients/direct.client.ts
      clients/litellm.client.ts           # opt-in sidecar
      selector.ts                         # multi-criteria scorer
      profiles.ts                         # LlmProfile definitions
    events/
      project-event-bus.interface.ts      # IProjectEventBus
      project-event-bus.factory.ts
      pg-notify-event-bus.ts
      in-memory-event-bus.ts
      sse-filter.ts                       # filterSSEEvent(event, perms)
    auth/
      permissions.ts                      # Permission type (27 permissions)
      built-in-roles.ts                   # 7 immutable built-in roles
      resolve-permissions.ts              # resolvePermissions(session, projectId)
      ownership.ts                        # assertRunAccess / assertProjectAccess
      api-key-validator.ts                # timingSafeEqual
    credentials/
      vault.ts                            # AES-256-GCM + ephemeral tokens
      llm-credential-vault.ts             # LlmProviderKey (Am.92)
    config-git/
      config-store.interface.ts           # IConfigStore
      git-config-store.ts
      paths.ts
    security/
      ssrf-protection.ts                  # assertNotPrivateHost
    utils/
      exec-safe.ts                        # execFile() + assertSafe*()
      safe-env.ts                         # safeBaseEnv, gitEnv, kiloEnv...
      input-validation.ts                 # assertSafeRef, assertSafeUrl...
    mcp/
      client.ts                           # McpSkillClient
      security-scan.ts                    # Gate 1 scan
    triggers/
      cron.ts                             # node-cron
      file-watcher.ts                     # chokidar
      webhook-validator.ts                # HMAC-SHA256
    context/
      optimizer.ts                        # L2→L1→L4 pipeline
    memory/
      memory-backend.interface.ts
      sqlite-vec.backend.ts
    audit/
      audit-log.ts
    bootstrap/
      validate-interfaces.ts              # Am.82.9 — startup check
      validate-optional-deps.ts           # Am.95 feature-gated deps
    updates/
      verify-update.ts                    # 3-layer: digest + SHA + Cosign
      release-pins.yaml                   # config.git/instance/
  app/
    api/
      auth/[...all]/route.ts              # toNextJsHandler(auth)
      runs/route.ts                       # POST → createRun
      runs/[runId]/
        route.ts                          # GET state
        stream/route.ts                   # SSE ReadableStream
        gate/route.ts                     # POST gate decision
        pause/route.ts                    # POST pause (Am.63)
        resume/route.ts                   # POST resume (Am.63)
        inject/route.ts                   # POST inject (Am.64)
        nodes/[nodeId]/gate/route.ts      # POST interrupt gate (Am.65)
      projects/
        route.ts
        [id]/route.ts
        [id]/stream/route.ts              # aggregated project SSE (Am.78.6)
        [id]/members/route.ts
      admin/
        models/route.ts
        skills/route.ts
        triggers/route.ts
        credentials/route.ts
      webhooks/[projectId]/[triggerId]/route.ts
      v1/
        runs/route.ts
        runs/[runId]/route.ts
        projects/route.ts
        profiles/route.ts
        analytics/route.ts
      analytics/route.ts
      README.md                           # endpoint documentation
  types/
    api.ts                                # frontend contracts
    events.ts                             # RunSSEEvent union
    run.ts                                # RunStatus, NodeStatus enums
    auth.ts                               # Session, User (inferred from Better Auth)
    rbac.ts                               # Permission enum (importable client-side)
  scripts/
    verify-migration-baseline.js          # CI check down.sql
  .github/
    workflows/
      pr.yml                              # typecheck + lint + unit + migration check
      main.yml                            # Docker build + staging smoke test
      release.yml                         # Electron sign + E2E + publish
```

**Modified existing files**:
- `package.json` — all dependencies + `optionalDependencies`
- `tsconfig.json` — strict mode confirmed, path aliases `@/`
- `next.config.ts` — security headers (CSP, HSTS, X-Frame-Options, etc.)

---

### Architectural risks

| Risk | Severity | Likelihood | Mandatory mitigation |
|---|---|---|---|
| **`ProjectRole` dual-write** (enum → model) | Critical | High | Transitional `role_slug` column during migration; both columns co-exist until fully validated. Seed validates 7 built-in roles after migration. |
| **Better Auth schema merge** complexity | High | High | Use `npx @better-auth/cli generate` on every update. NEVER define `User`/`Session`/`Account` manually. Follow Am.46.E exactly. |
| **Credential vault key co-location** | Critical | High | `ENCRYPTION_KEY` and `DATABASE_URL` in separate secrets, never in the same file. CI control + startup integration test. |
| **SSE scaling single-instance** | Medium | Medium | `PgNotifyEventBus` decouples event generation from SSE transport. `EventPayload` 30s buffer absorbs reconnects. Future horizontal scaling: `PgNotify` is naturally multi-process. |
| **SSRF via custom LLM URLs** | Critical | High | `assertNotPrivateHost()` called on EVERY custom LLM URL before the first call. DNS resolution + IP check. ESLint rule on fetch without assertion. |
| **Malicious npm postinstall hooks** | High | Medium | `--ignore-scripts` mandatory in all worktree + smoke test contexts. `npm audit` in CI (blocks on critical vulnerabilities). |
| **PostgreSQL-only partial index** | Low | High | `@@index([last_heartbeat], where: "status = 'RUNNING'")` — PostgreSQL conditional index. For SQLite: fallback to unconditional index in conditional seed `if (process.env.DATABASE_PROVIDER === 'sqlite')`. |
| **Supply chain: tag rewrite** | High | Low | `release-pins.yaml` with `git_commit` SHA + mandatory Cosign from v1. Lessons from Trivy attack (March 2026). |
| **`EventPayload` table bloat** | Low | High | Daily cron `DELETE WHERE expires_at < NOW()`. Default TTL: 24h. Present in seed migration. |
| **Argon2id memory on Electron** | Medium | Medium | Resolve at startup: `ARGON2_MEMORY_KB` env var → else `DEPLOYMENT_MODE === 'electron'` → 19456 KB → else 65536 KB. Never hardcoded. |

---

## Implementation Process

### Step 1 — T1.1 Docker + environment skeleton ✅
**Complexity**: Low | **Depends on**: nothing
**Success criteria**:
- `docker compose up` starts Next.js on :3000 and Postgres on :5432
- `.env.example` documents all required variables (TECHNICAL.md Section 10)
- `.env.test` configured for CI
- `orchestrator.yaml` present with default config (no secrets)

**Subtasks**:
1. Create `docker-compose.yml` (services: app, db)
2. Create `.env.example` with all vars from TECHNICAL.md Section 10
3. Create `.env.test`
4. Create `orchestrator.yaml` (default runtime config)
5. Verify: `docker compose up --build` → no errors
6. Verify: Postgres accessible on :5432, Next.js on :3000

**Blocker**: yes — all subsequent steps depend on this

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- `docker compose up --build` succeeds without error (0–2 pts)
- All variables documented in `.env.example` (0–2 pts)
- `.env.test` present and usable in CI (0–1 pt)

---

### Step 2 — T1.2 Prisma schema (complete) ✅
**Complexity**: High | **Depends on**: Step 1

**Success criteria**:
- All models present: `User`, `Project`, `Run`, `Node`, `Handoff`, `HumanGate`, `AuditLog`, `Trigger`, `ProjectRole`, `ProjectMember`, `ProjectApiKey`, `ProjectCredential`, `EventPayload`, `RunActorStats`, `EvalResult`, `MemoryResource`
- Am.85 fields present: `user_rating`, `estimated_hours_saved`, `task_input_chars`, `business_value_note`, `config_git_hash`
- Am.86/87 fields present: `ui_locale`, `transparency_language`
- `migration.sql` + `down.sql` both present
- `npx prisma migrate deploy` succeeds on clean DB
- Better Auth tables merged correctly: `user`, `session`, `account`, `verification`, `totp_credentials`, `passkey`, `api_key`

**Subtasks**:
1. Write `prisma/schema.prisma` complete (all models except `User`)
2. Run `npx @better-auth/cli generate` and merge `User` table manually
3. Add all amendment fields (Am.63/64/65/78/79/80/83/85/86/87)
4. Generate initial migration: `prisma migrate dev --name init`
5. Write `down.sql` manually (reverse migration)
6. Verify deployment on clean DB

**Blocker**: yes — T1.3 (auth) and T1.4 (executor) depend on schema

#### Verification
Level: Panel of 2 | Threshold: 4.5
Rubric:
- All models from V1_SCOPE.md present (0–3 pts)
- Amendment fields (Am.78/79/80/83/85/86/87) present (0–1 pt)
- `npx prisma migrate deploy` succeeds without error; `down.sql` present (0–1 pt)

---

### Step 3 — T1.3 Better Auth + RBAC seeds
**Complexity**: High | **Depends on**: Step 2

**Success criteria**:
- `/api/auth/*` routes functional (login, logout, session)
- Magic link email configured (Resend or SMTP)
- TOTP setup flow working
- Passkey registration + login working
- 7 built-in `ProjectRole` rows seeded (viewer / operator / user / user_with_costs / developer / admin / instance_admin)
- `resolvePermissions(session, projectId)` returns correct `Set<Permission>`
- All 27 permissions defined (Am.78.3)
- First admin bootstrap: `emailVerified: new Date()` exception documented

**Subtasks**:
1. Write `lib/auth/auth.ts` (`betterAuth()` complete config with Better Auth >=1.3.26)
2. Write `lib/auth/rbac.ts` (`resolvePermissions()`, 27 permissions enum)
3. Write `lib/auth/ownership.ts` (`assertRunAccess()`, `assertProjectAccess()`)
4. Write `lib/db/client.ts` (Prisma singleton)
5. Write `app/api/auth/[...all]/route.ts` (`toNextJsHandler(auth)`)
6. Write `prisma/seed.ts`: 7 built-in `ProjectRole` rows + admin bootstrap
7. Write `types/auth.ts` (Session, User types exported for frontend)
8. Test: login flow end-to-end

**Blocker**: yes — all API routes depend on auth; T1.8 (SSE permission filtering) depends on this

#### Verification
Level: Panel of 2 | Threshold: 4.5
Rubric:
- `/api/auth/signin` and `/api/auth/session` work end-to-end (0–2 pts)
- `resolvePermissions()` returns correct `Set<Permission>` for all 7 roles (0–2 pts)
- 7 built-in roles seeded; admin bootstrap exception works (0–1 pt)

---

### Step 4 — T1.4 DAG Executor — state machine core
**Complexity**: High | **Depends on**: Step 2

**Success criteria**:
- `IExecutionEngine` interface implemented (Am.82.5)
- `executeRun()` transitions: PENDING → RUNNING → COMPLETED
- Single-node run works end-to-end with `MockLLMClient`
- `cancelRun()`, `pauseRun()`, `resumeRun()` implemented
- Unit tests: 5 DAG fixtures (linear, parallel, branching, failed, paused)

**Subtasks**:
1. Write `lib/execution/engine.interface.ts` (`IExecutionEngine` Am.82.5)
2. Write `lib/execution/custom/state-machine.ts` (`RunStatus` transitions)
3. Write `lib/execution/custom/executor.ts` (`CustomExecutor`)
4. Write `lib/execution/engine.factory.ts` (`createExecutionEngine()` by `DEPLOYMENT_MODE`)
5. Write `lib/llm/mock-client.ts` (`MockLLMClient` for tests)
6. Write `tests/execution/executor.test.ts` + 5 fixture JSON files
7. Export `types/execution.ts` (IExecutionEngine, ExecutionConfig, RunStatus)

**Blocker**: yes — T1.5, T1.6, T1.7 depend on this

#### Verification
Level: Panel of 2 | Threshold: 4.5
Rubric:
- `executeRun()` completes a linear DAG correctly end-to-end (0–2 pts)
- `cancelRun()`, `pauseRun()`, `resumeRun()` functional (0–2 pts)
- All 5 test fixtures pass (0–1 pt)

---

### Step 5 — T1.5 DAG Executor — parallel + heartbeat + orphan detection
**Complexity**: Medium | **Depends on**: Step 4

**Success criteria**:
- Multiple READY nodes execute in parallel (`Promise.all`)
- `MAX_CONCURRENT_NODES` respected (from `orchestrator.yaml`)
- Heartbeat updated every 30s on running nodes
- Orphan detection: nodes with stale heartbeat → FAILED
- Crash recovery: on startup, resume RUNNING runs (Am.34.3b)
- Unit tests: parallel DAG completes faster than sequential

**Subtasks**:
1. Extend `lib/execution/custom/executor.ts` (parallel scheduling)
2. Write `lib/execution/custom/heartbeat.ts` (heartbeat loop)
3. Write `lib/execution/custom/orphan-detector.ts` (stale heartbeat → FAILED)
4. Write `lib/execution/custom/crash-recovery.ts` (SIGTERM handler + startup resume)
5. Update tests: parallel fixture timing assertion

**Blocker**: yes — T1.6 and T1.7 depend on this; T1.8 convergence point

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Parallel nodes execute concurrently (0–2 pts)
- Orphan detection triggers FAILED state correctly (0–2 pts)
- Crash recovery resumes RUNNING runs on startup (0–1 pt)

---

### Step 6 — T1.6 Classifier + Planner agents
**Complexity**: Medium | **Depends on**: Step 5

**Success criteria**:
- `IntentClassifier` produces `DomainProfile` + confidence
- Low confidence (< 0.8) triggers clarification gate
- `Planner` produces valid DAG JSON from `task_input`
- `MockLLMClient` used — real LLM wired in T1.9
- Unit tests: 3 classification scenarios, 2 planning scenarios

**Subtasks**:
1. Write `lib/agents/agent.interface.ts` (`IAgentRunner` Am.82)
2. Write `lib/agents/classifier.ts` (`IntentClassifier`)
3. Write `lib/agents/planner.ts` (DAG producer, Planner rules 1–7)
4. Write `lib/agents/handoff.ts` (Zod schema validation for handoffs)
5. Write `tests/agents/classifier.test.ts` + `planner.test.ts`
6. Export `types/dag.types.ts` (DagInput, DagNode, DagEdge)

**Blocker**: no — runs in parallel with Step 7

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Classifier outputs correct DomainProfile + confidence (0–2 pts)
- Planner produces valid DAG JSON from task input (0–2 pts)
- All classification and planning test scenarios pass (0–1 pt)

---

### Step 7 — T1.7 Writer + Standard Reviewer agents
**Complexity**: Medium | **Depends on**: Step 5

**Success criteria**:
- `Writer` produces content via `IAgentRunner` (Am.82)
- Streaming: tokens flow through to SSE (Am.65)
- `AbortController` propagated (interruption works)
- `Standard Reviewer` produces `ReviewResult` with findings
- Unit tests with `MockLLMClient`

**Subtasks**:
1. Write `lib/agents/writer.ts` (streaming via `IAgentRunner`)
2. Write `lib/agents/reviewer.ts` (Standard Reviewer)
3. Extend `lib/agents/handoff.ts` (`HandoffPayload`, `ReviewResult`)
4. Write `tests/agents/writer.test.ts` + `reviewer.test.ts`
5. Export `types/handoff.types.ts` (HandoffPayload, ReviewResult, ReviewVerdict)

**Blocker**: no — runs in parallel with Step 6

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Writer outputs content with working streaming (0–2 pts)
- Reviewer produces `ReviewResult` with findings (0–2 pts)
- `AbortController` interruption works (0–1 pt)

---

### Step 8 — T1.8 IProjectEventBus + SSE routes + API routes
**Complexity**: High | **Depends on**: Steps 3 + 5 + 6 + 7

**Success criteria**:
- `PgNotifyEventBus` working (Docker)
- `InMemoryEventBus` working (Electron / tests)
- `GET /api/projects/:id/stream` returns SSE (requires `project:read`)
- `GET /api/runs/:id/stream` returns SSE (requires `stream:state`)
- SSE filtered by permission (Am.78.6)
- `EventPayload` stored for 30s reconnect buffer (Am.79)
- Integration test: client receives `state_change` event
- All core CRUD API routes implemented (Project, Run, Gate, Fork)
- `openapi/v1.yaml` extracted from TECHNICAL.md §4B.6 and committed
- `types/api.ts` generated from `openapi/v1.yaml` via `openapi-typescript` — not hand-written

**Subtasks**:
1. Write `lib/events/event-bus.interface.ts` (`IProjectEventBus`)
2. Write `lib/events/pg-notify.bus.ts` (`PgNotifyEventBus`)
3. Write `lib/events/in-memory.bus.ts` (`InMemoryEventBus`)
4. Write `lib/events/event-bus.factory.ts` (`createEventBus()` by `DEPLOYMENT_MODE`)
5. Write `lib/bootstrap/validate-interfaces.ts` (startup interface verification)
6. Write `app/api/runs/route.ts` + `[runId]/*` routes (POST, GET, gate, fork)
7. Write `app/api/projects/route.ts` + `[projectId]/*` routes
8. Write SSE routes: `runs/[runId]/stream`, `projects/[projectId]/stream`
9. Write `tests/events/event-bus.test.ts`
10. Extract `openapi/v1.yaml` from TECHNICAL.md §4B.6 (public `/api/v1/*` routes only)
11. Run `npx openapi-typescript openapi/v1.yaml -o types/api.ts` — commit generated file
12. Add `"generate:types": "openapi-typescript openapi/v1.yaml -o types/api.ts"` to `package.json` scripts
13. Export `types/events.ts`, `types/run.ts` (hand-written; internal routes not in OpenAPI spec)

**Blocker**: yes — T1.9 and all Phase 2–3 steps depend on this

#### Verification
Level: Panel of 2 | Threshold: 4.5
Rubric:
- SSE stream delivers correct events to client (0–2 pts)
- Permission filtering on SSE verified (viewer cannot see `cost_update`) (0–2 pts)
- `EventPayload` reconnect buffer works (0–1 pt)

---

### Step 9 — T1.9 LLM routing + providers
**Complexity**: High | **Depends on**: Steps 3 + 8

**Success criteria**:
- `DirectLLMClient` works with Anthropic, OpenAI, Gemini, Mistral
- Multi-criteria LLM scorer (trust, jurisdiction, cost, confidentiality)
- CometAPI connector (Am.71) — OpenAI-compatible, base URL override
- Ollama local auto-detection (no auth vs Cloud Bearer)
- `createLLMClient()` factory respects `orchestrator.yaml` config
- Integration test: run completes with real Haiku (`HARMOVEN_LLM_TIER=haiku`)

**Subtasks**:
1. Write `lib/llm/provider.interface.ts` (`ILLMClient`)
2. Write `lib/llm/providers/anthropic.ts`, `openai.ts`, `google.ts`, `mistral.ts`, `ollama.ts`, `comet-api.ts`
3. Write `lib/llm/selector.ts` (multi-criteria scorer)
4. Write `lib/llm/profiles.ts`, `lib/llm/provider.ts`
5. Write `lib/llm/confidentiality.ts` (Confidentiality Classifier — NER + regex, local)
6. Write `lib/llm/client.factory.ts` (`createLLMClient()`)
7. Write `tests/llm/selector.test.ts`
8. Integration test: real Haiku run end-to-end

**Blocker**: yes — Phase 2 depends on this

#### Verification
Level: Panel of 2 | Threshold: 4.5
Rubric:
- `createLLMClient()` selects correct provider based on config (0–2 pts)
- Multi-criteria scorer weights trust/jurisdiction/cost/confidentiality (0–2 pts)
- Integration test with real Haiku passes (0–1 pt)

---

**[VALIDATION CHECKPOINT — After T1.9: first real LLM run with Haiku. Human approval required before Phase 2.]**

---

### Step 10 — T2A.1 Smoke Test Agent + Preview cascade
**Complexity**: High | **Depends on**: Step 9

**Success criteria**:
- `SmokeTestAgent` runs after DevOps Agent
- Preview cascade: subdomain → subpath → screenshots (Am.73)
- Port allocator (3100–3199) assigns preview port
- `RepairAgent` ($0.05 budget cap) auto-fixes subpath failures
- Puppeteer screenshots generated for 3 key pages
- Integration test: scaffold project → preview URL accessible

**Subtasks**:
1. Write `lib/agents/scaffolding/smoke-test-agent.ts`
2. Write `lib/agents/scaffolding/preview/cascade.ts`
3. Write `lib/agents/scaffolding/preview/port-allocator.ts`
4. Write `lib/agents/scaffolding/preview/repair-agent.ts`
5. Write `lib/agents/scaffolding/preview/screenshot.ts` (Puppeteer)
6. Integration test: scaffold → preview URL accessible

**Blocker**: no — runs in parallel with Steps 11–14

#### Verification
Level: Panel of 2 | Threshold: 4.0
Rubric:
- Preview cascade resolves URL correctly (subdomain → subpath) (0–2 pts)
- Port allocator assigns within 3100–3199 range (0–1 pt)
- Puppeteer screenshots generated for key pages (0–2 pts)

---

### Step 11 — T2A.2 Platform detection + clarification gates
**Complexity**: Medium | **Depends on**: Step 9
**Backend scope**: `platform-detector.ts` only (clarification wizard UI is frontend)

**Success criteria**:
- Platform auto-detected from project files
- Mobile clarification: iOS/Android/PWA/RN (Am.74.12)
- Hardware clarification: Arduino/RPi/ESP/STM32 (Am.74.22)
- Closed platform hard block: PS5, Switch (Am.74.17)

**Subtasks**:
1. Write `lib/agents/scaffolding/platform-detector.ts`
2. Define platform detection rules in `orchestrator.yaml`
3. Unit tests: 3 detection scenarios (mobile/hardware/closed)

**Blocker**: no

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Platform auto-detected correctly from project files (0–2 pts)
- Closed platform block enforced (returns hard block) (0–2 pts)
- Mobile/hardware detection correct (0–1 pt)

---

### Step 12 — T2A.2b ILayerAgentExecutor + Kilo CLI stub
**Complexity**: Low | **Depends on**: Step 9

**Success criteria**:
- `ILayerAgentExecutor` interface implemented (Am.72)
- `LLMDirectExecutor` working end-to-end (default)
- `createLayerAgentExecutor()` uses dynamic import (Am.95.2)
- `KiloCliExecutor`: STUB only (throws `NotImplementedError`)
- Unit test: `LLMDirectExecutor` runs Writer node end-to-end

**Subtasks**:
1. Write `lib/agents/scaffolding/layer-agent-executor.factory.ts`
2. Write `lib/agents/scaffolding/executors/llm-direct.executor.ts`
3. Write `lib/agents/scaffolding/executors/kilo-cli.executor.ts` (STUB)
4. Unit test: `LLMDirectExecutor` end-to-end

**Blocker**: no

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- `LLMDirectExecutor` runs Writer node correctly end-to-end (0–2 pts)
- `KiloCliExecutor` throws `NotImplementedError` as required (0–2 pts)
- Dynamic import factory works correctly (0–1 pt)

---

### Step 13 — T2A.3 Critical Reviewer
**Complexity**: Medium | **Depends on**: Step 9
**Backend scope**: `critical-reviewer.ts` + audit log (gate UI is frontend)

**Success criteria**:
- Severity 0–5 configurable (default: 3 per domain)
- Max 3 findings enforced
- Targeted fix agent ($0.10 budget cap) on [Fix this]
- Audit log entry on each ignored finding

**Subtasks**:
1. Write `lib/agents/critical-reviewer.ts`
2. Add audit log entries for ignored findings
3. Unit tests: 3 reviewer scenarios (severity levels, max findings)

**Blocker**: no — Step 14 (EvalAgent) depends on this (shared gate Am.94.2)

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Severity enforcement and max-3-findings cap correct (0–2 pts)
- Targeted fix stays within $0.10 budget cap (0–2 pts)
- Audit log entries created on ignored findings (0–1 pt)

---

### Step 14 — T2A.4 EvalAgent
**Complexity**: High | **Depends on**: Step 13

**Success criteria**:
- Sprint contract negotiation works (Planner ↔ EvalAgent)
- Domain rubrics implemented for 4 profiles (app_scaffolding, document_drafting, data_reporting, marketing_content)
- Retry loop: max 2 retries, feedback passed to Writer
- `EvalResult` stored in DB

**Subtasks**:
1. Write `lib/agents/eval/eval-agent.ts`
2. Write `lib/agents/eval/rubrics/app_scaffolding.rubric.ts`
3. Write `lib/agents/eval/rubrics/document_drafting.rubric.ts`
4. Write `lib/agents/eval/rubrics/data_reporting.rubric.ts`
5. Write `lib/agents/eval/rubrics/marketing_content.rubric.ts`
6. Implement retry loop with feedback pass to Writer
7. Store `EvalResult` in DB

**Blocker**: no

#### Verification
Level: Panel of 2 | Threshold: 4.0
Rubric:
- Sprint contract negotiation works (Planner ↔ EvalAgent) (0–2 pts)
- Retry loop with feedback correct (max 2, feedback passed) (0–2 pts)
- `EvalResult` stored in DB correctly (0–1 pt)

---

**[VALIDATION CHECKPOINT — After T2A.1: preview cascade live on scaffolded app. Human approval required.]**

---

### Step 15 — T2B.1 Fine-grained RBAC
**Complexity**: High | **Depends on**: Step 8

**Success criteria**:
- `ProjectRole` model replaces enum (dual-write migration, 3 steps)
- `ProjectApiKey` (`hv1_` prefix) replaces better-auth `api_key`
- `resolvePermissions()` cached (in-memory TTL 60s)
- All 27 permissions enforced on API routes
- Member management routes: GET/POST `/api/projects/:id/members`, DELETE `/api/projects/:id/members/:userId`

**Subtasks**:
1. Migration SQL: create `ProjectRole` table + nullable FK `role_id` on `ProjectMember`
2. Migration seed: 7 built-in roles + copy enum → `role_id`
3. Migration SQL: drop `role` enum column (separate migration)
4. Write `lib/auth/project-api-key.ts` (`hv1_` prefix management)
5. Write `app/api/projects/[projectId]/members/route.ts` + `[userId]/route.ts`
6. Add TTL caching layer to `resolvePermissions()`

**Blocker**: no — runs in parallel with Step 16

#### Verification
Level: Panel of 2 | Threshold: 4.5
Rubric:
- Dual-write migration executes without data loss (0–2 pts)
- All 27 permissions enforced on relevant API routes (0–2 pts)
- `ProjectApiKey` `hv1_` prefix and `resolvePermissions()` caching correct (0–1 pt)

---

### Step 16 — T2B.2 Config GitOps
**Complexity**: Medium | **Depends on**: Step 8
**Backend scope**: `lib/config-git/*` (diff/history UI is frontend)

**Success criteria**:
- `config.git` initialized at startup
- Auto-commit on every `PATCH /api/projects/:id` config change
- `orchestrator.yaml` auto-synced at startup
- `syncToDb()` called on restore (forward commit)

**Subtasks**:
1. Write `lib/config-git/client.ts`
2. Write `lib/config-git/sync.ts` (startup sync + auto-commit)
3. Write `lib/config-git/history.ts` (log + restore)
4. Wire auto-commit hook to PATCH project routes

**Blocker**: no

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- `config.git` initialized and auto-commits on PATCH (0–2 pts)
- `orchestrator.yaml` auto-synced at startup (0–2 pts)
- Restore creates forward commit + `syncToDb()` called (0–1 pt)

---

**[VALIDATION CHECKPOINT — After T2B.1: RBAC demo with 3 roles. Human approval required.]**

---

### Step 17 — T3.1 Kanban + multi-run view
**Complexity**: Low | **Depends on**: Step 8
**Backend scope**: verify project-level SSE stream completeness (frontend Kanban is out of scope)

**Success criteria**:
- `GET /api/projects/:id/stream` delivers all run status updates
- `HumanGate` events visible in project stream
- All missing event types added to `IProjectEventBus`

**Subtasks**:
1. Audit project-level SSE stream: verify all status events are emitted
2. Add any missing event types to `IProjectEventBus`
3. Ensure `HumanGate` events are emitted to project stream

**Blocker**: no

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Project SSE delivers all run status change events (0–3 pts)
- `HumanGate` events visible in project stream (0–2 pts)

---

### Step 18 — T3.2 User control (Pause / Inject / Interrupt)
**Complexity**: Medium | **Depends on**: Steps 8 + 9

**Success criteria**:
- Pause/Resume working (run config stored, state preserved)
- Context injection mid-run visible to Writer agent
- Node interruption via `AbortController`
- Interrupt Gate (3 options: edit partial / replay / accept)

**Subtasks**:
1. Extend `lib/execution/custom/executor.ts` (pause/resume/inject)
2. Write `app/api/runs/[runId]/pause/route.ts` + `resume/route.ts` + `inject/route.ts`
3. Write `app/api/runs/[runId]/nodes/[nodeId]/interrupt/route.ts`
4. Write `app/api/runs/[runId]/nodes/[nodeId]/gate/route.ts`

**Blocker**: no

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Pause/Resume preserves run state correctly (0–2 pts)
- Context injection reaches Writer agent mid-run (0–2 pts)
- Node interruption via `AbortController` works (0–1 pt)

---

### Step 19 — T3.3 Marketplace
**Complexity**: Medium | **Depends on**: Steps 8 + 9
**Backend scope**: `lib/marketplace/install-pack.ts` + admin skill routes (browse UI is frontend)

**Success criteria**:
- Pack install from GitHub registry working
- Pack version management (update_policy: auto/notify/manual)
- Local overrides preserved on update
- Bayesian rating stored in DB

**Subtasks**:
1. Write `lib/marketplace/install-pack.ts` (pack install, version mgmt)
2. Write `app/api/admin/skills/route.ts` + `[id]/route.ts`
3. Define pack registration format in `orchestrator.yaml`

**Blocker**: no — Step 24 (T3.8) adds GPG+hash verification on top of this

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Pack install + version management correct (0–3 pts)
- Local overrides preserved on update (0–2 pts)

---

### Step 20 — T3.4 Analytics dashboard
**Complexity**: Medium | **Depends on**: Steps 8 + 9
**Backend scope**: `lib/analytics/*` + API route (dashboard UI is frontend)

**Success criteria**:
- `GET /api/v1/analytics` returns JSON/CSV/PDF
- `computeUserPeriodStats()` working
- 5 board KPIs with delta vs previous period

**Subtasks**:
1. Write `lib/analytics/compute.ts` (`computeUserPeriodStats()`)
2. Write `lib/analytics/export.ts` (JSON/CSV/PDF export)
3. Write `app/api/analytics/route.ts` + `app/api/v1/analytics/route.ts`

**Blocker**: no

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- `/api/v1/analytics` returns correct JSON/CSV/PDF formats (0–3 pts)
- `computeUserPeriodStats()` calculates KPIs with delta correctly (0–2 pts)

---

### Step 21 — T3.5 CI/CD pipeline
**Complexity**: Medium | **Depends on**: Steps 1–8 all complete

**Success criteria**:
- All 3 pipeline levels working (PR, main, release)
- PR pipeline < 5 minutes
- `verify-migration-baseline.js` blocks on missing `down.sql`
- `check-translations.js` flags missing `fr.json` keys
- OpenAPI drift check: `npm run generate:types && git diff --exit-code types/api.ts` fails CI if types drifted from `openapi/v1.yaml`

**Subtasks**:
1. Write `.github/workflows/pr.yml`
2. Write `.github/workflows/main.yml`
3. Write `.github/workflows/release.yml`
4. Write `scripts/check-translations.js`
5. Write `scripts/verify-migration-baseline.js`
6. Add `openapi-typescript` drift check step to `pr.yml` and `main.yml`

**Blocker**: no — Step 24 (T3.8) pins CI action SHAs on top of this

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- PR pipeline green and runs in < 5 minutes (0–2 pts)
- `verify-migration-baseline.js` catches missing `down.sql` (0–2 pts)
- `check-translations.js` flags missing translation keys (0–1 pt)

---

### Step 22 — T3.6 Update management
**Complexity**: Medium | **Depends on**: Step 21
**Backend scope**: `lib/updates/*` + `electron/auto-updater.ts` (UpdateBanner UI is frontend)

**Success criteria**:
- Docker: version check API working when new version available
- Docker: guided update wizard with migration preview
- Electron: `electron-updater` silent download
- Electron: SQLite backup before migration

**Subtasks**:
1. Write `lib/updates/` (version check, migration preview)
2. Write `electron/auto-updater.ts` (electron-updater + SQLite backup)
3. Wire `orchestrator.yaml` `updates.auto_install` preference

**Blocker**: no

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- Version check API returns new version info correctly (0–2 pts)
- Electron updater downloads silently + backs up SQLite (0–2 pts)
- `auto_install` preference respected (0–1 pt)

---

### Step 23 — T3.7 i18n — en + fr
**Complexity**: Low | **Depends on**: Steps 8 + 9

**Success criteria**:
- ~340 keys in `en.json` (all UI strings)
- `fr.json` complete (no `[TODO-TRANSLATE]` remaining)
- 3-level detection cascade working
- `transparency_language` follows `ui_locale` by default

**Subtasks**:
1. Write `locales/en.json` (~340 keys)
2. Write `locales/fr.json` (complete translation)
3. Write `lib/i18n/detect.ts` (3-level cascade)
4. Write `lib/i18n/t.ts`
5. `scripts/check-translations.js` already written in Step 21

**Blocker**: no

#### Verification
Level: Single Judge | Threshold: 4.0
Rubric:
- `en.json` + `fr.json` complete and consistent (no missing keys) (0–3 pts)
- 3-level detection cascade works (browser → user pref → default) (0–2 pts)

---

### Step 24 — T3.8 Supply chain security
**Complexity**: Medium | **Depends on**: Steps 19 + 21

**Success criteria**:
- LiteLLM runs as isolated Docker sidecar (no shared env with app)
- ESLint `no-restricted-imports` blocks direct `litellm` import
- Marketplace pack install verifies GPG signature + content hash
- MCP skill SHA256 verified at startup
- CI actions pinned by commit SHA (not tag) in all workflows

**Subtasks**:
1. Add LiteLLM sidecar to `docker-compose.yml` (isolated network)
2. Add GPG + hash verification to `lib/marketplace/install-pack.ts`
3. Write `lib/security/supply-chain-monitor.ts`
4. Pin CI action SHAs in all `.github/workflows/` files
5. Add MCP skill SHA256 verification at startup

**Blocker**: no — Step 25 (T3.9) extends this

#### Verification
Level: Panel of 2 | Threshold: 4.5
Rubric:
- LiteLLM isolated correctly (no shared env vars with app) (0–2 pts)
- GPG + content hash verification for marketplace packs (0–2 pts)
- All CI actions pinned by commit SHA (0–1 pt)

---

### Step 25 — T3.9 Security hardening
**Complexity**: High | **Depends on**: Steps 21 + 24

**Success criteria**:
- All `exec()` calls migrated to `execFile()` + `assertSafe*()`
- ESLint rule bans `exec()` with template literals
- `safeBaseEnv()` used in all child process contexts
- `assertNotPrivateHost()` called on all custom LLM base URLs (SSRF)
- Docker socket proxy (Tecnativa) in `docker-compose.yml`
- `contextIsolation=true`, `nodeIntegration=false` in Electron `BrowserWindow`
- Ephemeral `CredentialVault` per run (issueRunScope / revokeRunScope)
- `timingSafeEqual()` for all API key comparisons
- gitleaks scan on generated worktrees
- HTTP security headers in `next.config.ts` (CSP, HSTS, X-Frame-Options)
- `release-pins.yaml` CI job in `.github/workflows/release.yml`

**Subtasks**:
1. Write `lib/utils/exec-safe.ts` (`execFile()` + `assertSafe*()`)
2. Write `lib/utils/input-validation.ts`
3. Write `lib/utils/safe-env.ts` (`safeBaseEnv()` whitelist)
4. Write `lib/security/ssrf-protection.ts` (`assertNotPrivateHost()`)
5. Write `lib/execution/credential-scope.ts` (ephemeral vault per run)
6. Write `lib/auth/api-key-validator.ts` (`timingSafeEqual()`)
7. Write `lib/agents/scaffolding/secret-scanner.ts` (gitleaks wrapper)
8. Update `next.config.ts` (CSP/HSTS/X-Frame-Options/X-Content-Type-Options)
9. Add docker-socket-proxy (Tecnativa) to `docker-compose.yml`
10. Update Electron `BrowserWindow` (`contextIsolation=true`, `nodeIntegration=false`)
11. Configure ESLint `no-exec` rule (+ `no-restricted-imports` on direct impls)
12. Write `release-pins.yaml` CI job + three-layer verification (digest + SHA + Cosign)

**Blocker**: no — final hardening pass

#### Verification
Level: Panel of 2 | Threshold: 4.5
Rubric:
- All `exec()` replaced by `execFile()` everywhere; ESLint rule active (0–2 pts)
- `assertNotPrivateHost()` applied to all LLM base URLs (0–1 pt)
- Ephemeral credential vault per run functional (0–1 pt)
- HTTP security headers + Electron hardening present (0–1 pt)

---

**[FINAL VALIDATION CHECKPOINT — E2E: 5 app_scaffolding scenarios pass. Human approval required.]**

---

## Parallelization Plan

### Hard dependencies (mandatory sequential)

```
Step 1 (T1.1) → Step 2 (T1.2) → Step 3 (T1.3)   auth requires schema
Step 2 (T1.2) → Step 4 (T1.4)                      executor requires schema
Step 3 (T1.3) → Step 8 (T1.8)                      SSE permission filtering requires auth
Step 4 (T1.4) → Step 5 (T1.5)                      parallel executor extends core
Step 5 (T1.5) → Steps 6 + 7                         agents require stable executor
Steps 3+5+6+7 → Step 8 (T1.8)                      EventBus convergence point
Steps 3+8    → Step 9 (T1.9)                        LLM routing needs auth + SSE
Step 13 (T2A.3) → Step 14 (T2A.4)                  EvalAgent shared gate (Am.94.2)
Steps 19+21 → Step 24 (T3.8) → Step 25 (T3.9)     supply chain before hardening
```

### Parallelization opportunities

- **Steps 6 + 7** (T1.6 Classifier/Planner + T1.7 Writer/Reviewer): both depend only on Step 5. Assign simultaneously to two developers — no shared files.
- **Steps 10 + 11 + 12 + 13** (T2A.1–T2A.3): all depend only on Step 9. All 4 can run simultaneously in Phase 2A. No cross-dependencies until Step 14.
- **Steps 15 + 16** (T2B.1 RBAC + T2B.2 Config GitOps): both depend only on Step 8. No shared files. Assign simultaneously.
- **Steps 17–20** (T3.1–T3.4): all depend on Steps 8 + 9. Can all run in parallel in Phase 3 start.
- **Steps 22 + 23** (T3.6 Update mgmt + T3.7 i18n): no inter-dependency, both depend on Steps 8+9. Run in parallel.
- **Step 21** (T3.5 CI/CD) can start whenever Steps 1–8 are all green — does not depend on Phase 2 completion.

### Recommended execution plan

| Week | Steps | Parallel? | Notes |
|---|---|---|---|
| 1 | Step 1 — T1.1 (Docker + env) | No | Blocker for everything |
| 1 | Step 2 — T1.2 (Prisma schema) | No (after Step 1) | Blocker for T1.3 + T1.4 |
| 2 | Step 3 — T1.3 (Better Auth + RBAC) | No (after Step 2) | Critical path — security |
| 2 | Step 4 — T1.4 (DAG Executor core) | **Yes** (parallel with Step 3) | Dep: Step 2 only |
| 2-3 | Step 5 — T1.5 (DAG parallel + heartbeat) | No (after Step 4) | Extends T1.4 |
| 3 | Step 6 — T1.6 (Classifier + Planner) | **Yes** (parallel with Step 7) | Dep: Step 5 only |
| 3 | Step 7 — T1.7 (Writer + Reviewer) | **Yes** (parallel with Step 6) | Dep: Step 5 only |
| 3-4 | Step 8 — T1.8 (EventBus + SSE + API routes) | No (4-way convergence) | Steps 3+5+6+7 must be done |
| 4 | Step 9 — T1.9 (LLM routing) | No (after Step 8) | ✅ Validation checkpoint |
| 4-5 | Step 10 — T2A.1 (Smoke Test + Preview) | **Yes** (parallel with 11+12+13) | Phase 2A starts |
| 4-5 | Step 11 — T2A.2 (Platform detection) | **Yes** (parallel with 10+12+13) | Backend only |
| 4-5 | Step 12 — T2A.2b (ILayerAgentExecutor) | **Yes** (parallel with 10+11+13) | |
| 4-5 | Step 13 — T2A.3 (Critical Reviewer) | **Yes** (parallel with 10+11+12) | Step 14 depends on this |
| 5 | Step 14 — T2A.4 (EvalAgent) | No (after Step 13) | Shared gate Am.94.2 |
| 5 | Step 15 — T2B.1 (Fine-grained RBAC) | **Yes** (parallel with Step 16) | ✅ Validation checkpoint |
| 5 | Step 16 — T2B.2 (Config GitOps) | **Yes** (parallel with Step 15) | |
| 6 | Step 17 — T3.1 (SSE completeness audit) | **Yes** (parallel with 18+19+20) | Phase 3 |
| 6 | Step 18 — T3.2 (Pause/Inject/Interrupt) | **Yes** (parallel with 17+19+20) | |
| 6 | Step 19 — T3.3 (Marketplace) | **Yes** (parallel with 17+18+20) | |
| 6 | Step 20 — T3.4 (Analytics) | **Yes** (parallel with 17+18+19) | |
| 6 | Step 21 — T3.5 (CI/CD pipeline) | **Yes** (parallel with 17–20) | Unblocked once Steps 1–8 done |
| 7 | Step 22 — T3.6 (Update management) | **Yes** (parallel with Step 23) | After Step 21 |
| 7 | Step 23 — T3.7 (i18n) | **Yes** (parallel with Step 22) | After Steps 8+9 |
| 7-8 | Step 24 — T3.8 (Supply chain security) | No (after Steps 19+21) | |
| 8 | Step 25 — T3.9 (Security hardening) | No (after Steps 21+24) | Final pass ✅ |

### Agent assignments

| Step | Task | Agent type | Reason |
|---|---|---|---|
| Step 1 | T1.1 Docker + env | developer | Config files, low complexity |
| Step 2 | T1.2 Prisma schema | developer (senior) | Large schema, amendment fields, Better Auth merge — critical path |
| Step 3 | T1.3 Better Auth + RBAC | developer (security) | Auth — security-critical, 7-role seed |
| Step 4 | T1.4 DAG Executor core | developer (senior) | Complex state machine |
| Step 5 | T1.5 DAG parallel + heartbeat | developer (senior) | Extends T1.4, crash recovery |
| Step 6 | T1.6 Classifier + Planner | developer | Agent impl, MockLLMClient |
| Step 7 | T1.7 Writer + Reviewer | developer | Agent impl, streaming |
| Step 8 | T1.8 EventBus + SSE + API | developer (senior) | 4-way convergence, 10 subtasks, permission filtering |
| Step 9 | T1.9 LLM routing | developer (senior) | Multi-provider, external integrations |
| Step 10 | T2A.1 Smoke Test + Preview | developer | Puppeteer, port allocator |
| Step 11 | T2A.2 Platform detection | developer | Detection rules, backend only |
| Step 12 | T2A.2b ILayerAgentExecutor | developer | Interface + stub |
| Step 13 | T2A.3 Critical Reviewer | developer | Severity enforcement |
| Step 14 | T2A.4 EvalAgent | developer (senior) | 4 rubrics, retry loop, shared gate |
| Step 15 | T2B.1 Fine-grained RBAC | developer (security) | Dual-write migration, 27 permissions |
| Step 16 | T2B.2 Config GitOps | developer | Git lib, auto-commit |
| Steps 17–20 | T3.1–T3.4 | developer | Parallel Phase 3 start |
| Step 21 | T3.5 CI/CD | developer (devops) | Pipeline config, scripts |
| Steps 22–23 | T3.6–T3.7 | developer | Update mgmt + i18n |
| Step 24 | T3.8 Supply chain | developer (security) | GPG, hash verification |
| Step 25 | T3.9 Security hardening | developer (security) | Broad security pass |

### Coordination risks

- **Step 8 (T1.8) convergence**: four branches (Steps 3, 5, 6, 7) must all be fully merged before T1.8 starts. Risk: a branch slightly incomplete blocks all SSE work. Mitigation: P8 agent for T1.8 reads all four upstream step verification logs before starting.
- **Step 2 (T1.2) Prisma schema**: shared file `prisma/schema.prisma` — Better Auth CLI generates into it. If T1.3 (Step 3) merges user tables incorrectly, T1.4+ executor migrations may fail silently. Mitigation: strict Panel-of-2 verification at threshold 4.5 before any dependent step begins.
- **Steps 6 + 7 parallel**: both write to `lib/agents/` — risk of naming conflicts if both assign the `IAgentRunner` interface simultaneously. Mitigation: Step 6 owns `agent.interface.ts` and writes `IAgentRunner`; Step 7 imports, never redefines.
- **Steps 15 + 16 parallel**: T2B.1 writes new Prisma migrations; T2B.2 initializes `config.git`. No schema conflicts since T2B.2 only reads `orchestrator.yaml`, not `schema.prisma`.
- **Steps 21 + 24 sequential on CI workflows**: Step 21 creates the workflow files; Step 24 must pin their action SHAs. If both run concurrently, SHA pinning is applied to partial workflow files. Mitigation: enforce Step 21 completion before Step 24 starts.

### Parallelization score: 4.5/5

Maximum sequential pipeline (8 weeks, 1 developer): Steps 1→2→3→4→5→6→8→9→…→25 = ~16 weeks.
With parallelization (2 developers): ~8 weeks.
Constraint preventing higher score: Step 8 (T1.8) is an unavoidable 4-way convergence. No architectural change can remove this — the EventBus requires Auth (session), DAG (executor), Classifier, and Writer to be wired simultaneously.

---

## Definition of Done

### Infrastructure
- [ ] `docker compose up --build` succeeds on a clean machine (no local dependencies pre-installed)
- [ ] `npx prisma migrate deploy` succeeds on a clean empty database
- [ ] `npx prisma migrate deploy` with `down.sql` reverse migration also succeeds
- [ ] All Docker services pass their healthcheck (`app`, `db`, LiteLLM sidecar)
- [ ] `.env.example` contains every variable referenced in the codebase (verified by `grep -r process.env`)
- [ ] `orchestrator.yaml` loads without validation error at startup

### Auth
- [ ] `POST /api/auth/signin` → 200 with valid credentials
- [ ] `POST /api/auth/signin` → 401 with wrong password
- [ ] `POST /api/auth/signout` → session invalidated immediately (`cookieCache: { enabled: false }`)
- [ ] Magic link email sent and functional (non-blocking: can use mock SMTP in CI)
- [ ] TOTP verify flow functional end-to-end
- [ ] Passkey registration + login end-to-end
- [ ] First admin bootstrap: `emailVerified: new Date()` exception seeded correctly
- [ ] `resolvePermissions(session, projectId)` returns correct `Set<Permission>` for all 7 built-in roles
- [ ] `assertRunAccess()` returns 403 on a run belonging to a different project
- [ ] `assertProjectAccess()` returns 403 for a user with no `ProjectMember` entry

### DAG Execution
- [ ] `PENDING → RUNNING → COMPLETED` state machine correct for linear DAG (MockLLMClient)
- [ ] `cancelRun()` stops all in-progress nodes within 1s
- [ ] `pauseRun()` then `resumeRun()`: full run state preserved
- [ ] All 5 DAG fixtures pass: `linear`, `parallel`, `branching`, `failed`, `paused`
- [ ] Parallel DAG completes faster than sequential equivalent (timing assertion in test)
- [ ] Heartbeat updated every 30s on running nodes (verified via DB poll in test)
- [ ] Orphan detection: node with stale heartbeat transitions to `FAILED`
- [ ] Crash recovery: RUNNING runs resumed on server restart (Am.34.3b)
- [ ] `MAX_CONCURRENT_NODES` from `orchestrator.yaml` respected

### Agents
- [ ] `IntentClassifier`: low confidence (< 0.8) triggers clarification gate
- [ ] `Planner`: produces valid DAG JSON (passes Zod schema validation)
- [ ] DAG terminal node is `reviewer` (Planner rule #7 enforced)
- [ ] Planner: max 3 re-runs on rejection (Am.47.3)
- [ ] `Writer`: tokens streamed via SSE; `AbortController` interrupts correctly
- [ ] `Standard Reviewer`: produces `ReviewResult` with `findings` array
- [ ] `Critical Reviewer`: max 3 findings enforced; severity configurable per domain
- [ ] `EvalAgent`: retry loop correct (max 2 retries, feedback passed to Writer)
- [ ] `EvalResult` written to DB after each evaluation

### SSE + EventBus
- [ ] `GET /api/runs/:id/stream` requires `stream:state` permission → 403 without it
- [ ] `GET /api/projects/:id/stream` requires `project:read` permission → 403 without it
- [ ] `viewer` role does NOT receive `cost_update`, `gate_opened`, `budget_warning` events
- [ ] `EventPayload` buffer: client reconnecting within 30s receives missed events
- [ ] `EventPayload` cleanup: records older than 24h deleted by daily cron
- [ ] Integration test: SSE client receives `state_change` event on run status update
- [ ] `PgNotifyEventBus` functional in Docker environment
- [ ] `InMemoryEventBus` functional in test/Electron environment

### API routes
- [ ] All routes enforce `assertRunAccess()` or `assertProjectAccess()` before DB query
- [ ] All write routes produce an `AuditLog` entry (actor, action, payload diff)
- [ ] All routes validate body with Zod `.strict()` — extra fields rejected
- [ ] `POST /api/runs` rate-limited to 10/min per user
- [ ] `POST /api/auth/signin` rate-limited to 5 requests per 15 minutes
- [ ] `GET /api/admin/credentials` never returns `value_enc` or decrypted credential value
- [ ] Error responses always use `{ error: { code, message, details? } }` — no stack traces

### LLM routing
- [ ] `createLLMClient()` selects correct provider based on `orchestrator.yaml` config
- [ ] Multi-criteria scorer weights: trust tier, jurisdiction, cost, confidentiality
- [ ] CometAPI connector (Am.71): OpenAI-compatible base URL override works
- [ ] Ollama local auto-detection: no-auth vs Cloud Bearer detected from URL
- [ ] Integration test: run completes end-to-end with real Haiku (`HARMOVEN_LLM_TIER=haiku`)
- [ ] `partial_output` flushed every 5s (not per chunk — verified in Writer test)
- [ ] Ephemeral `CredentialVault` per run: token issued for call, revoked in `finally` block

### Security
- [ ] IDOR: `GET /api/runs/:id` for a run in another project → 403
- [ ] Audit log: all write actions recorded, entries immutable (no DELETE route on AuditLog)
- [ ] `npm audit` → 0 critical severity vulnerabilities
- [ ] `better-auth` version pinned to `>=1.3.26` (CVE-2025-61928 — no `^`)
- [ ] `timingSafeEqual()` used for all API key comparisons (`hv1_` prefix keys)
- [ ] `assertNotPrivateHost()` called on all custom LLM base URLs (SSRF protection)
- [ ] `execFile()` used for all child process calls — no `exec()` with template literals
- [ ] ESLint `no-exec` rule active and enforced in CI
- [ ] `safeBaseEnv()` used in all child process contexts (no full `process.env` passthrough)
- [ ] `contextIsolation: true`, `nodeIntegration: false` in Electron `BrowserWindow`
- [ ] Docker socket mounted via Tecnativa socket-proxy (not directly)
- [ ] HTTP security headers present: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
- [ ] gitleaks scan runs on generated worktrees (no secrets committed)
- [ ] MCP skill SHA256 verified at startup
- [ ] Marketplace pack install verifies GPG signature + content hash

### Frontend contracts (backend deliverables)
- [ ] `types/api.ts` generated from `openapi/v1.yaml` via `openapi-typescript` (never hand-edited)
- [ ] `openapi/v1.yaml` present and valid OpenAPI 3.1.0
- [ ] CI drift check passes: `npm run generate:types && git diff --exit-code types/api.ts` → clean
- [ ] `types/events.ts` lists all SSE event types with their discriminated union payloads
- [ ] `types/run.ts` contains `RunStatus`, `NodeStatus`, `GateDecision`, `HumanGateStatus` enums
- [ ] `types/auth.ts` exports `Session`, `User`, `Permission` enum (usable client-side)
- [ ] `types/dag.types.ts` exports `DagInput`, `DagNode`, `DagEdge`
- [ ] `types/handoff.types.ts` exports `HandoffPayload`, `ReviewResult`, `ReviewVerdict`
- [ ] `types/execution.ts` exports `IExecutionEngine`, `ExecutionConfig`
- [ ] `types/llm.types.ts` exports `LlmProfile`, `LlmTier`, `LlmJurisdiction`

### Code quality
- [ ] `npx tsc --noEmit` → 0 TypeScript errors
- [ ] `npm test` → all tests pass (unit + integration)
- [ ] `npm run build` → compiles without error (Next.js build succeeds, even without frontend pages)
- [ ] `scripts/verify-migration-baseline.js` → 0 migrations without `down.sql`
- [ ] `scripts/check-translations.js` → 0 missing keys between `en.json` and `fr.json`
- [ ] All `lib/bootstrap/validate-interfaces.ts` checks pass at server startup

### Human approval gates (manual — not automatable)
- [ ] **After Step 9 (T1.9)**: first real LLM run with Haiku approved by human ✋
- [ ] **After Step 10 (T2A.1)**: preview cascade demo on scaffolded app approved by human ✋
- [ ] **After Step 15 (T2B.1)**: RBAC demo with 3 roles, different permission views approved by human ✋
- [ ] **Final**: E2E scenario: 5 `app_scaffolding` runs complete successfully, approved by human ✋

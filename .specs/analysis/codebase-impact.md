# Codebase Impact Analysis — Harmoven v1
# Agent: code-explorer | Date: 2026-03-25 | Score: 4.5/5

---

## Current architecture

The workspace contains only the `dev/` directory with project specs.
**No application code exists yet.** The repo is pre-code, not pre-spec.

```
harmoven/
└── dev/
    ├── mockups/          # HTML statiques — hors scope implémentation
    ├── prompts/          # Specs (TECHNICAL.md, TASKS.md, AGENTS-*.md, etc.)
    └── skills/           # Skills MCP référencés (ui-ux-pro-max, sdd/)
```

The project starts from scratch — no files to modify, everything is to be created.

---

## Files to create per phase (TASKS.md)

> **Scope reminder**: only backend files are listed here.
> `app/(app)/**/*.tsx`, `app/(auth)/**/*.tsx`, `components/`, `hooks/`, `styles/` → separate frontend sprint.

---

### Phase 1 — Foundation (T1.1 → T1.9)

#### T1.1 — Docker + environment skeleton
```
docker-compose.yml
.env.example
.env.test
orchestrator.yaml              ← main config (no secrets)
next.config.ts                 ← CSP/HSTS/CORS headers, HTTP security
```

#### T1.2 — Prisma schema (complete)
```
prisma/schema.prisma
prisma/seed.ts                 ← 7 built-in ProjectRole rows + LlmProfile defaults
prisma/migrations/
  20260325_000001_init/
    migration.sql
    down.sql                   ← mandatory (Am.84)
```

Models to include in the initial migration:
- `Project`, `Run`, `Node`, `Handoff`, `HumanGate`, `AuditLog`
- `Trigger`, `LlmProfile`, `McpSkill`, `MemoryResource`
- `ProjectMember`, `ProjectRole` (model, NOT enum — Am.78)
- `ProjectApiKey` (Am.78), `EventPayload` (Am.79)
- `RunActorStats` (Am.80 — present, disabled by default)
- `EvalResult` (Am.89)
- `ProjectCredential`, `OAuthToken`, `WebhookDelivery`
- `UserPreference`, `InstalledPack`, `SourceTrustEvent`, `GitWorktree`
- Better Auth tables via merge: `user`, `session`, `account`, `verification`,
  `totp_credentials`, `passkey`, `api_key`

Mandatory amendment fields:
- `Run.user_rating`, `Run.estimated_hours_saved`, `Run.task_input_chars`,
  `Run.business_value_note`, `Run.config_git_hash` (Am.85)
- `User.ui_locale`, `User.transparency_language` (Am.86/87)
- `Run.transparency_mode` (Am.61), `Run.user_injections` (Am.64)
- `Run.paused_at` (Am.63), `Node.interrupted_at`, `Node.interrupted_by`,
  `Node.partial_output`, `Node.partial_updated_at` (Am.65)

#### T1.3 — Better Auth + RBAC seeds
```
lib/auth/auth.ts               ← betterAuth() complete config
lib/auth/rbac.ts               ← resolvePermissions(), 27 permissions enum
lib/auth/ownership.ts          ← assertRunAccess(), assertProjectAccess()
lib/db/client.ts               ← Prisma singleton
app/api/auth/[...all]/route.ts ← toNextJsHandler(auth)
prisma/seed.ts                 ← 7 built-in ProjectRole rows
types/auth.ts                  ← Session, User types exported (frontend)
```

#### T1.4 — DAG Executor core
```
lib/execution/engine.interface.ts          ← IExecutionEngine (Am.82.5)
lib/execution/custom/executor.ts           ← CustomExecutor implements IExecutionEngine
lib/execution/custom/state-machine.ts      ← RunStatus transitions
lib/execution/engine.factory.ts            ← createExecutionEngine() by DEPLOYMENT_MODE
tests/execution/executor.test.ts           ← 5 fixtures (linear, parallel, branching, failed, paused)
tests/execution/fixtures/
  linear.dag.json
  parallel.dag.json
  branching.dag.json
  failed.dag.json
  paused.dag.json
```

#### T1.5 — DAG Executor parallel + heartbeat + orphan
```
lib/execution/custom/heartbeat.ts          ← heartbeat loop (30s)
lib/execution/custom/orphan-detector.ts    ← stale heartbeat → FAILED
lib/execution/custom/crash-recovery.ts     ← SIGTERM handler + resume on startup
lib/llm/mock-client.ts                     ← MockLLMClient for tests
types/execution.ts                         ← DAG, NodeStatus, RunStatus types (frontend)
```

#### T1.6 — Classifier + Planner agents
```
lib/agents/classifier.ts
lib/agents/planner.ts
lib/agents/agent.interface.ts              ← IAgentRunner (Am.82)
tests/agents/classifier.test.ts
tests/agents/planner.test.ts
types/dag.types.ts                         ← DagInput, DagNode, etc. (frontend)
```

#### T1.7 — Writer + Standard Reviewer agents
```
lib/agents/writer.ts
lib/agents/reviewer.ts
lib/agents/handoff.ts                      ← Zod schema validation
tests/agents/writer.test.ts
tests/agents/reviewer.test.ts
types/handoff.types.ts                     ← HandoffPayload, ReviewResult (frontend)
```

#### T1.8 — IProjectEventBus + SSE routes
```
lib/events/event-bus.interface.ts          ← IProjectEventBus
lib/events/pg-notify.bus.ts               ← PgNotifyEventBus (Docker)
lib/events/in-memory.bus.ts               ← InMemoryEventBus (Electron/tests)
lib/events/event-bus.factory.ts           ← createEventBus() by DEPLOYMENT_MODE
app/api/runs/[runId]/stream/route.ts      ← GET SSE — permission: stream:state
app/api/projects/[projectId]/stream/route.ts  ← GET SSE — permission: project:read
types/events.ts                            ← RunSSEEvent, all event types (frontend)
tests/events/event-bus.test.ts
```

#### T1.9 — LLM routing + providers
```
lib/llm/provider.interface.ts             ← ILLMClient
lib/llm/selector.ts                       ← multi-criteria scorer
lib/llm/profiles.ts                       ← LLM profile registry
lib/llm/provider.ts                       ← provider abstraction
lib/llm/confidentiality.ts               ← Confidentiality Classifier (NER + regex, local)
lib/llm/providers/
  anthropic.ts
  openai.ts
  google.ts
  mistral.ts
  ollama.ts
  comet-api.ts                            ← Am.71 — OpenAI-compatible base URL
lib/llm/client.factory.ts                 ← createLLMClient()
tests/llm/selector.test.ts
```

---

### Phase 2A — Scaffolding track (T2A.1 → T2A.4)

#### T2A.1 — Smoke Test Agent + Preview cascade
```
lib/agents/scaffolding/smoke-test-agent.ts
lib/agents/scaffolding/preview/
  cascade.ts
  port-allocator.ts
  repair-agent.ts
  screenshot.ts                            ← Puppeteer
```

#### T2A.2 — Platform detection + ILayerAgentExecutor
```
lib/agents/scaffolding/platform-detector.ts
lib/agents/scaffolding/layer-agent-executor.factory.ts
lib/agents/scaffolding/executors/
  llm-direct.executor.ts
  kilo-cli.executor.ts                     ← STUB, throws NotImplementedError
```

#### T2A.3 — Critical Reviewer
```
lib/agents/critical-reviewer.ts
```

#### T2A.4 — EvalAgent
```
lib/agents/eval/
  eval-agent.ts
  rubrics/
    app_scaffolding.rubric.ts
    document_drafting.rubric.ts
    data_reporting.rubric.ts
    marketing_content.rubric.ts
```

---

### Phase 2B — Quality + Permissions track (T2B.1 → T2B.2)

#### T2B.1 — Fine-grained RBAC
```
lib/auth/project-api-key.ts               ← ProjectApiKey management
app/api/projects/[projectId]/members/route.ts
app/api/projects/[projectId]/members/[userId]/route.ts
prisma/migrations/20260325_000002_add_rbac_am78/
  migration.sql
  down.sql
```

#### T2B.2 — Config GitOps
```
lib/config-git/
  client.ts
  sync.ts
  history.ts
```

---

### Phase 3 — Integration + hardening (T3.1 → T3.9)

#### T3.5 — CI/CD
```
.github/workflows/pr.yml
.github/workflows/main.yml
.github/workflows/release.yml
scripts/check-translations.js
scripts/verify-migration-baseline.js
```

#### T3.7 — i18n
```
locales/en.json
locales/fr.json
lib/i18n/
  detect.ts
  t.ts
```

#### T3.8 — Supply chain security
```
lib/marketplace/install-pack.ts
lib/security/supply-chain-monitor.ts
```

#### T3.9 — Security hardening
```
lib/utils/exec-safe.ts                    ← execFile() + assertSafe*()
lib/utils/input-validation.ts
lib/utils/safe-env.ts                     ← safeBaseEnv() whitelist
lib/security/ssrf-protection.ts          ← assertNotPrivateHost()
lib/execution/credential-scope.ts        ← ephemeral CredentialVault per run
lib/auth/api-key-validator.ts            ← timingSafeEqual()
lib/agents/scaffolding/secret-scanner.ts ← gitleaks wrapper
```

#### T3.4 — Analytics
```
lib/analytics/
  compute.ts
  export.ts
app/api/analytics/route.ts               ← GET /api/v1/analytics (JSON/CSV/PDF)
app/api/v1/analytics/route.ts
```

---

### Internal API routes (all phases)

```
app/api/auth/[...all]/route.ts                          ← T1.3
app/api/runs/route.ts                                   ← POST (T1.8)
app/api/runs/[runId]/route.ts                           ← GET (T1.8)
app/api/runs/[runId]/stream/route.ts                    ← GET SSE (T1.8)
app/api/runs/[runId]/gate/route.ts                      ← POST (T1.8)
app/api/runs/[runId]/fork/route.ts                      ← POST (T1.8)
app/api/runs/[runId]/pause/route.ts                     ← POST (T3.2)
app/api/runs/[runId]/resume/route.ts                    ← POST (T3.2)
app/api/runs/[runId]/inject/route.ts                    ← POST (T3.2)
app/api/runs/[runId]/nodes/[nodeId]/route.ts            ← GET (T1.8)
app/api/runs/[runId]/nodes/[nodeId]/interrupt/route.ts  ← POST (T3.2)
app/api/runs/[runId]/nodes/[nodeId]/gate/route.ts       ← POST (T3.2)
app/api/projects/route.ts                               ← GET, POST (T1.8)
app/api/projects/[projectId]/route.ts                   ← GET, PATCH, DELETE (T1.8)
app/api/projects/[projectId]/members/route.ts           ← GET, POST (T2B.1)
app/api/projects/[projectId]/members/[userId]/route.ts  ← DELETE (T2B.1)
app/api/projects/[projectId]/stream/route.ts            ← GET SSE (T1.8)
app/api/admin/models/route.ts                           ← GET, POST (T1.9)
app/api/admin/models/[id]/route.ts                      ← PATCH (T1.9)
app/api/admin/skills/route.ts                           ← GET, POST
app/api/admin/skills/[id]/route.ts                      ← PATCH
app/api/admin/triggers/route.ts                         ← GET, POST
app/api/admin/triggers/[id]/route.ts                    ← PATCH
app/api/admin/credentials/route.ts                      ← GET, POST
app/api/admin/credentials/[id]/route.ts                 ← PATCH, DELETE
app/api/webhooks/[projectId]/[triggerId]/route.ts       ← POST
```

### Public API routes v1

```
app/api/v1/runs/route.ts                                ← POST, GET
app/api/v1/runs/[runId]/route.ts                        ← GET, DELETE
app/api/v1/projects/route.ts                            ← GET
app/api/v1/projects/[id]/route.ts                       ← GET
app/api/v1/profiles/route.ts                            ← GET
app/api/v1/analytics/route.ts                           ← GET (T3.4)
```

---

## Shared types (frontend contracts)

```
types/
  auth.ts          ← Session, User, Permission enum (exporté côté client)
  api.ts           ← CreateRunRequest, CreateRunResponse, GateDecisionRequest, etc.
  events.ts        ← RunSSEEvent — all SSE event types with their payloads
  run.ts           ← RunStatus, NodeStatus, GateDecision, HumanGateStatus enums
  dag.types.ts     ← DagInput, DagNode, DagEdge
  handoff.types.ts ← HandoffPayload, ReviewResult, ReviewVerdict
  llm.types.ts     ← LlmProfile, LlmTier, LlmJurisdiction
  execution.ts     ← IExecutionEngine, ExecutionConfig
```

---

## Critical interfaces (never break)

| Interface | Fichier | Implémentations |
|---|---|---|
| `IExecutionEngine` | `lib/execution/engine.interface.ts` | CustomExecutor, TemporalExecutor, RestateExecutor |
| `IAgentRunner` | `lib/agents/agent.interface.ts` | Classifier, Planner, Writer, Reviewer, CriticalReviewer |
| `ILLMClient` | `lib/llm/provider.interface.ts` | AnthropicClient, OpenAIClient, GoogleClient, MockLLMClient |
| `IProjectEventBus` | `lib/events/event-bus.interface.ts` | PgNotifyEventBus, InMemoryEventBus |
| `ILayerAgentExecutor` | `lib/agents/scaffolding/layer-agent-executor.factory.ts` | LLMDirectExecutor, KiloCliExecutor (stub) |
| `IMemoryBackend` | `lib/context/memory.ts` | (abstrait — v2 LightRAG) |

---

## Patterns to follow

### Naming
- Files: `kebab-case.ts` (not `camelCase.ts`)
- Interfaces : préfixe `I` — `IExecutionEngine`, `IAgentRunner`
- Factories : suffix `factory.ts` + export `createXxx()`
- Tests : `tests/` à la racine, structure miroir de `lib/`

### Error handling
- All API routes: Zod `.strict()` validation before business logic
- All GET routes: `assertRunAccess()` or `assertProjectAccess()` before DB query
- All write routes: audit log entry (actor, action, payload diff)
- Error response: `{ error: { code, message, details? } }` — never a stack trace

### Security invariants (mandatory on EVERY route)
1. Check session before any operation
2. `assertRunAccess()` / `assertProjectAccess()` before DB query
3. Zod `.strict()` on the body
4. Audit log entry on each write
5. Rate limit on POST /api/runs (10/min), POST /api/auth/signin (5/15min)
6. GET /api/admin/credentials: never return `value_enc` or decrypted value

### Streaming
- All main LLM calls: `stream: true` + `AbortController`
- `AbortSignal` propagated to the underlying `fetch` (critical for Ollama)
- `partial_output` flushed every 5s (not per chunk)

---

## Dependency graph (build order)

```
T1.1 (Docker+env) ──────────────────────────────────────────────────────────┐
    │                                                                         │
    ▼                                                                         │
T1.2 (Prisma schema) ─────────────────────────┐                             │
    │                                          │                             │
    ▼                                          ▼                             │
T1.3 (Auth+RBAC) ←──── bloquant sécurité   T1.4 (DAG core)                 │
    │                                          │                             │
    │                                          ▼                             │
    │                                      T1.5 (parallel+heartbeat)         │
    │                                          │                             │
    │                              ┌───────────┴──────────┐                 │
    │                              ▼                       ▼                 │
    │                         T1.6 (Classifier+Planner)  T1.7 (Writer+Rev)  │
    │                              └───────────┬──────────┘                 │
    │                                          ▼                             │
    │                                      T1.8 (EventBus+SSE) ◄────────────┘
    │                                          │
    └──────────────────────────────────────────┤
                                               ▼
                                           T1.9 (LLM routing)
                                               │
                              ┌────────────────┼─────────────────┐
                              ▼                ▼                  ▼
                         Phase 2A          Phase 2B          Phase 3
                      (Scaffolding)     (RBAC+GitOps)   (Intégration)
```

---

## code-explorer Score: 4.5/5

Uncertain files:
- `orchestrator.yaml` full JSON schema — excerpts in specs, no formal schema
- `config.git/instance/release-pins.yaml` — generated by CI (Am.93), exact structure to be derived
- Electron main process (`electron/main.ts`, `electron/auto-updater.ts`) — out of scope for phases 1-2, to refine in T3.6

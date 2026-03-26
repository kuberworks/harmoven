# P8-T2A.1 — Smoke Test Agent + Preview cascade
**Agent**: developer  
**Date**: 2026-03-26  
**Score**: 5 / 5  

---

## What was implemented

### Files created
| File | Purpose |
|---|---|
| `lib/agents/scaffolding/port-allocator.ts` | DB-backed port pool (3100–3199) — `allocatePreviewPort()`, `releasePreviewPort()`, `getPreviewPort()` |
| `lib/agents/scaffolding/preview-cascade.ts` | Preview cascade (subdomain → subpath → screenshots); Traefik + proxy helpers; `smokeTestUrl()`, `checkRoutes()`, `captureScreenshots()` |
| `lib/agents/scaffolding/repair.agent.ts` | RepairAgent — detects framework, issues one targeted LLM call (fast tier, max 1000 tokens), patches config file, rebuilds |
| `lib/agents/scaffolding/smoke-test.agent.ts` | Orchestrator — docker compose up, health wait, route checks, cascade, repair loop, `teardownPreview()` |
| `prisma/migrations/20260326085002_add_preview_port_am73/migration.sql` | `PreviewPort` table (port UNIQUE, run_id UNIQUE) |
| `tests/agents/scaffolding/smoke-test.agent.test.ts` | 17 unit tests — all external I/O mocked (FS, fetch, Docker, DB) |

### Files modified
| File | Change |
|---|---|
| `prisma/schema.prisma` | Added `model PreviewPort` (Am.73 §25.6) |
| `lib/agents/runner.ts` | Added `SMOKE_TEST` and `REPAIR` dispatch cases |
| `orchestrator.yaml` | Added `app_scaffolding.preview` config block |

---

## Decisions

### Preview cascade — three ordered modes (Am.73 §25.3)
1. **Subdomain** — writes a Traefik dynamic YAML to `APP_SCAFFOLDING_TRAEFIK_DYNAMIC_DIR` (default `/etc/traefik/dynamic`). Requires wildcard DNS. Zero app modification.
2. **Subpath** — writes a proxy entry file under `APP_SCAFFOLDING_PROXY_DIR`; app must be able to serve under `/preview/{runId}/`. RepairAgent patches config if first attempt fails.
3. **Screenshots** — universal fallback. Puppeteer is an optional dependency; if absent, `captureScreenshots()` returns `[]` and continues without blocking.

### Container lifecycle
The container stays **alive during the Human Gate**. `teardownPreview(worktree, runId)` is the single teardown entry point — called by the Human Gate route handler on approve/abandon. Port is released at the same time.

### RepairAgent scope
Strictly limited to **config files** (next.config.js, vite.config.ts, express/fastify entrypoint). Never touches business logic. Budget cap enforced at the LLM call level (`maxTokens: 1000`).

### Port allocator idempotency
`allocatePreviewPort(runId)` first checks if the run already owns a port (DB round-trip) before scanning the range. Safe to call multiple times without leaking ports.

### DB cast via `(db as any).previewPort`
Prisma client types are regenerated at `prisma generate` time. During development the generated client doesn't yet reflect the new `PreviewPort` model — the cast avoids blocking compilation while the migration is pending. Will be removed once `prisma generate` runs in CI.

### `loadPreviewConfig()` precedence
Environment variables override orchestrator.yaml values. `AUTH_URL` is used as an automatic `base_url` fallback (standard Next.js convention) so most instances get subpath mode working without explicit config.

---

## Test results
```
Test Suites: 9 passed, 9 total
Tests:       5 skipped, 71 passed, 76 total
```

New scaffolding suite: **17 tests, all passing**.

---

## Spec coverage (Am.73)
| Section | Status |
|---|---|
| §25.1 Pipeline position (DevOps → Smoke → Human Gate) | ✅ documented in agent header |
| §25.2 SmokeTestResult / PreviewResult / RouteCheck types | ✅ |
| §25.3 Preview cascade (subdomain → subpath → screenshots) | ✅ |
| §25.4 RepairAgent (framework detection + config patch) | ✅ |
| §25.5 Human Gate — Preview tab props | ⏭ frontend (T2A.?) |
| §25.6 Port allocator (3100–3199, DB-backed) | ✅ |
| §25.7 Traefik dynamic config | ✅ |
| §25.8 Environment variables | ✅ |
| §25.9 Docker socket requirement | ✅ (note in smoke-test.agent.ts header) |

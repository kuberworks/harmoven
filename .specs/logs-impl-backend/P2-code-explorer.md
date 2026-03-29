## Agent: code-explorer | Date: 2026-03-25 | Score: 4.5/5

### Notable files discovered

- **Pre-code repo**: no existing application files — 100% of files are to be created. No legacy, no technical debt to manage.
- **Very complete specs**: TECHNICAL.md contains the full Prisma schema, all API routes, Better Auth code, SSE types — the "code to write" is largely already specified in the specs. T1.x tasks will mostly be copy-adapt from TECHNICAL.md.
- **Better Auth generates its tables**: the `npx @better-auth/cli generate` command is mandatory — the `user`, `session`, `account`, `verification`, `totp_credentials`, `passkey`, `api_key` tables must NOT be written by hand.
- **`types/` = explicit deliverables**: the `types/*.ts` files are explicitly named as frontend contracts — they are backend deliverables to be treated as such, not afterthoughts.

### Patterns to follow strictly

- **`IProjectEventBus` first**: wire the interface before creating SSE routes — routes go through the bus, never directly through PgNotify.
- **`assertRunAccess()` on every GET route**: non-negotiable security invariant — pattern to be copied on ALL routes.
- **`down.sql` on every migration**: CI script `verify-migration-baseline.js` checks this — omitting it fails the pipeline.
- **`execFile()` never `exec()`**: ESLint rule bans `exec()` with template literals — to be configured from T1.1.

### Uncertain files

- `orchestrator.yaml`: JSON schema not formalized in the specs — to be inferred from TECHNICAL.md Section 9 excerpts. Risk: missing fields.
- `config.git/`: GitOps directory (Am.83) — exact structure (subdirectories, files) to clarify at T2B.2.
- `electron/`: main Electron process — out of scope for phases 1-2, do not create before T3.6.
- `lib/context/memory.ts` (`IMemoryBackend`): abstract interface for v2 LightRAG — a stub is sufficient in v1.

### Notes for P4/P5

- **Strict Phase 1 order**: T1.1 → T1.2 → T1.3 (auth) AND T1.4 (executor) in parallel → T1.5 → T1.6+T1.7 → T1.8 → T1.9. Do not merge T1.3 and T1.4 in the same step — they have different dependencies.
- **`types/` at each step**: each step exposing a new API surface must export its types — do not leave this for the end.
- **SQLite for Electron**: `DATABASE_PROVIDER="sqlite"` — Prisma supports both, but some indexes (notably `@@index([last_heartbeat], where: ...)`) are PostgreSQL-only → conditional filters in the schema.
- **`RunActorStats` present, disabled**: the model must be in the initial migration even if `experimental.actor_stats.enabled = false`. Do not create the migration later.

### Open questions

- Exact values of `DEPLOYMENT_MODE` switch (`docker` | `electron` | other?)
- Full `orchestrator.yaml` structure — only partial excerpts in the specs
- The `@@index([last_heartbeat], where: "status = 'RUNNING'")` — PostgreSQL-only partial index: SQLite handling to clarify

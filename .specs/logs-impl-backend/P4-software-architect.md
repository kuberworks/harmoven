# P4 — Software Architect Log

**Date**: 2026-03-25
**Agent**: software-architect
**Input**: P1 Research Findings + P2 codebase-impact.md + P3 Acceptance Criteria
**Output**: `## Architecture Overview` in `harmoven-v1-implementation.feature.md`

---

## Sources read

| Source | Sections | Relevance |
|---|---|---|
| TECHNICAL.md | §5 DAG Executor, §6 LLM Routing, §8 Auth, §9 Config | Major technical decisions |
| TECHNICAL.md | §29 IProjectEventBus, §28 RBAC, §31 Interface Catalogue | Interface contracts |
| TECHNICAL.md | §32 Config GitOps, §40 Credential Vault, §42 Security Hardening | Security |
| TECHNICAL.md | §39 Supply Chain, §41 Release Pins, §43 Feature Gates | DevOps infra |
| AGENTS-04-EXECUTION.md | Amendment 4.A, §34 DAG Executor complet | No-LangGraph context |
| .specs/analysis/codebase-impact.md | Phases T1.1–T3.9, files per phase | File consolidation |

---

## Validated architectural decisions

### IProjectEventBus — critical decoupling
`DagExecutor.emit()` → bus → SSE (never LISTEN/NOTIFY direct in routes).
Reason: allows substituting InMemoryEventBus in tests without modifying the executor.
Hard constraint: every SSE route goes through the bus, never through PgNotify directly.

### Factory-first for all interfaces (Am.82)
No implementation imported directly. `createExecutionEngine()`, `createAgentRunner()`, `createLLMClient()`, `createProjectEventBus()` are the only entry points.
`lib/bootstrap/validate-interfaces.ts` verifies all implementations at startup.

### SSE scope filtered by permission (Am.78.6)
`filterSSEEvent(event, perms)` called on each event before emission.
Permissions resolved ONCE at SSE connection open (not per event).
A `viewer` does not receive `cost_update`, `gate_opened`, `budget_warning`.

### Dual-write ProjectRole — migration strategy
3-step migration:
1. SQL migration: create `ProjectRole` table + nullable FK `role_id` column on `ProjectMember`
2. Seed: create 7 built-in roles + copy old `role` enum to `role_id`
3. Next SQL migration: drop the `role` enum column

Never in a single migration (risk of data loss in production).

### Better Auth — strict integration contract
- `npx @better-auth/cli generate` MANDATORY before any schema migration
- `User` never manually defined in `schema.prisma`
- `cookieCache: { enabled: false }` — force-revocation instant
- First admin: `emailVerified: new Date()` exception documented in seed

### Ephemeral credential tokens (Am.92)
Each LLM call in `executeNode()` uses an ephemeral token from the vault, invalidated in the `finally` block.
A run using Claude Haiku NEVER has access to Claude Opus keys.
`process.env.ANTHROPIC_API_KEY` ignored in `vault` mode (orchestrator.yaml).

---

## Resolved ambiguities

| Ambiguity | Resolution |
|---|---|
| Partial index PostgreSQL in Prisma | `@@index([last_heartbeat], where: "...")` → PostgreSQL only. For SQLite: non-conditional index in conditional seed. |
| EventPayload cleanup | Daily cron in seed.ts (no separate service). TTL: 24h configurable. |
| `down.sql` for ProjectRole migration | Keep `down.sql` that restores the enum — document "DATA LOSS WARNING" if custom role records exist. |
| Local Ollama without auth vs Ollama Cloud with Bearer | `createOllamaClient()` detects via endpoint URL — no interface change. |

---

## Notes for P5 (tech-lead)

1. **Strict build order**: Prisma schema must precede Better Auth CLI generate (both share `prisma/schema.prisma`)
2. **T1.5 before T1.8**: `IProjectEventBus` instantiated before `CustomExecutor` — the DAG Executor injects the bus via constructor
3. **`lib/bootstrap/validate-interfaces.ts`** must be called BEFORE `httpServer.listen()` — if an interface fails, `process.exit(1)`
4. **MockLLMClient** created in T1.7 in parallel with `DirectLLMClient` — required for all unit tests (`HARMOVEN_LLM_TIER=mock`)
5. **Seed in two passes**: (a) 7 roles + admin bootstrap; (b) conditional test fixtures (`NODE_ENV === 'test'`)
6. **Custom ESLint rules**: `no-restricted-imports` on direct implementations + `exec()` with template literal → configure in T1.1

## Notes for P6 (team-lead)

- T1.5 (EventBus) and T1.6/T1.7 (Engine + LLMClient) can be parallelized
- T2A.1 (Agents core) and T2B.1 (Admin routes) can be parallelized after T1.9
- Phase 3 fully parallelizable (T3.1–T3.8 independent of each other)
- Blocker: T1.8 (DAG Executor) strictly depends on T1.5 + T1.7

---

## P4 Score: 4.5/5

Unresolved points:
- Integration test architecture for IProjectEventBus (in-memory vs PgNotify) — to define in P5
- Rollback strategy for config.git in concurrent production (multiple admins) — documented but not implemented in P5

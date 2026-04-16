## Agent: researcher | Date: 2026-03-25 | Score: 4.5/5

### Retained decisions

- **Better Auth >=1.3.26 is a hard constraint**: strict pinning required by CVE-2025-61928. The dependency import must be locked — never `^1.3.x`.
- **No BullMQ, no Redis**: explicitly confirmed by TECHNICAL.md "NOT required". The event bus relies on PgNotify (Docker) or InMemory (Electron) via `IProjectEventBus`. Massively simplifies the stack.
- **Custom DAG Executor, not LangGraph**: explicit decision from TECHNICAL.md. Full control over state, no vendor lock. The `IExecutionEngine` pattern (Am.82) is the key — the 3 implementations (custom, temporal, restate) are interchangeable.
- **Prisma schema must NOT contain the User model**: Better Auth generates it via `npx @better-auth/cli generate`. Manual merge mandatory per Am.46.E. High risk of error if forgotten.
- **Dual-write migration Am.78**: `ProjectRole` moves from enum to model — the migration must keep the enum column during transition. Blocking if done wrong.
- **`down.sql` mandatory**: Am.84 requires a reverse migration on each migration. CI blocks. Must be implemented from T1.2.
- **`ENCRYPTION_KEY` never co-located with `DATABASE_URL`**: critical security constraint for the credential vault. Must be documented in `.env.example`.

### Rejected alternatives

| Alternative | Reason |
|---|---|
| Auth.js v5 (NextAuth) | Replaced by Better Auth (Am.46.A) — Auth.js in perpetual beta, lead maintainer left Jan 2025 |
| LangGraph | Anthropic vendor lock, less control — custom executor retained |
| Redis / BullMQ | Not required — native PgNotify/InMemory event bus sufficient for v1 |
| pgvector | Optional enterprise memory — out of scope v1 |
| LangChain | No identified utility in the stack |
| Organization plugin Better Auth | Not used (Am.46.C) — ProjectMember handles resource-level RBAC |

### Assumptions made

- `DEPLOYMENT_MODE` accepts values `docker` | `electron` — to confirm at implementation time (not explicitly documented in specs)
- `orchestrator.yaml` full schema is to be inferred from TECHNICAL.md Section 9 (specs provide excerpts, not the full schema)
- npm versions to pin at T1.1 (package.json does not exist yet)
- `better-auth` version >=1.3.26 available on npm at build time

### Notes for P3/P4

- **Critical security**: 4 high-priority areas — IDOR enforcement, audit log immutability, SSRF protection for LLM URLs, credential vault isolation. P3 ACs must cover them explicitly.
- **Frontend contracts**: `types/api.ts`, `types/events.ts`, `types/run.ts` are backend deliverables — must be included in the DoD.
- **Auth bootstrap exception**: first admin without email verification — important edge case for ACs.
- **Architecture P4**: the event bus (`IProjectEventBus`) must be wired from T1.8, BEFORE the SSE routes. Do not let P4 reinvent the order.
- **Prisma migrate**: initial migration must contain ALL schema models — including `EventPayload`, `ProjectRole` (model, not enum), `ProjectApiKey`, `RunActorStats`.

### Open questions

- Exact values of `DEPLOYMENT_MODE` — to confirm in T1.1
- Full `orchestrator.yaml` schema — excerpts available, complete JSON schema absent
- Exact npm versions to pin — resolved in T1.1

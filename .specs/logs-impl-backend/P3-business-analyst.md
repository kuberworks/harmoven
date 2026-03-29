## Agent: business-analyst | Date: 2026-03-25 | Score: 4.5/5

### ACs added vs initial draft

The initial draft only contained the "Research Findings" sections from the researcher.
All the following sections were added:

- `## Description`: precise backend scope, identified frontend deliverables
- `## Acceptance Criteria`: 12 domains covered, 70+ testable criteria with checkboxes
- `## Out of Scope (backend)` and `## Out of Scope (v1 product)`: clear boundaries

ACs added that were not obvious:
- Bootstrap exception `emailVerified: new Date()` for the first admin (Setup Wizard)
- Argon2id memory differentiated Docker (64MB) vs Electron (19MB)
- `timingSafeEqual()` for API keys (not stated explicitly in scope, but critical)
- UUID v7 mandatory for `Run.id` (v2 federation constraint — easy to miss)
- `partial_output` flush every 5s (not per chunk — critical perf)
- DAG: terminal node must be `reviewer` (Planner rule #7)
- Planner retry: max 3 re-runs (Am.47.3)
- `EventPayload` reconnect buffer 30s

### Tricky ACs (resolved ambiguities)

| Ambiguity | Decision | Reason |
|---|---|---|
| `CriticalReviewer` vs `StandardReviewer` | Distinct ACs — Standard in phase 1, Critical in T2A.3 | V1_SCOPE separates them; Standard is the minimum viable |
| MegaMemory skill in backend ACs | Excluded — it is an optional MCP skill, not backend logic | MCP skills are admin opt-in, not mandatory deliverables |
| Eval datasets (`/evals/`) | Excluded from v1 backend ACs — Am.48 is a test strategy, not a deliverable | `EvalAgent` (T2A.4) is in scope, the datasets themselves are separate |
| `orchestrator.yaml` schema | Included as implicit AC — "loaded at startup" | Without validation, it is a source of silent errors |
| `SSH_KEY` credential type | Included in Prisma schema (Am.15.A) | It is a type in `CredentialType` enum — SSH clone implementation out of scope for v1 |
| `transparency_language` vs `ui_locale` | Both included in schema AC | Am.86/87 clearly differentiates them |

### Out of Scope maintained

- **Frontend**: confirmed excluded. Types are in scope (contracts), React components are not.
- **E2E Tests**: Playwright/Cypress explicitly excluded. API routes tested via Node.js integration tests.
- **KiloCliExecutor** (full impl): STUB only (Am.95.2 specifies `NotImplementedError`). Backend AC = interface defined.
- **Marketplace UI** (T3.3): API routes not included in phase 1-2 ACs. To revisit in P5.
- **Config GitOps UI** (T2B.2 `ConfigHistory.tsx`): React component excluded, backend lib included.
- **EvalAgent rubrics** (T2A.4): 4 rubric domains — included in scope but not in core ACs. P5 will add them.

### Notes for P4

- **`IProjectEventBus` first**: P4 must position the event bus as a critical layer independent of SSE routes — do not allow the architecture to place routes in direct dependency on PgNotify.
- **`ProjectRole` model vs enum**: Am.78 requires a dual-write migration. P4 must document the migration sequence to avoid data corruption.
- **Frontend contracts = deliverables**: P4 must treat `types/` as a full architectural layer, not an afterthought. The frontend depends on it.
- **SSE filtering by permission**: Am.78.6 — the event bus must pass the session to each subscriber. The architecture must account for this mechanism.
- **Crash recovery at startup**: the SIGTERM handler + resuming RUNNING runs is an architecture concern (Am.34.3b). P4 must document it in the implementation strategy.

### Open questions

(Score 4.5 — no blocking questions)

- Full `orchestrator.yaml` JSON schema: inferred from spec excerpts — to be formalized in T1.1
- `EvalAgent` (T2A.4) precise sprint contract: Am.89 describes it but without a detailed rubric spec — to be handled in T2A.4
- `RunActorStats` model: present, but field structure not specified in detail (Am.80 is sparse) — AC = "present in migration, experimental disabled"

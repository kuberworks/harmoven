## Agent: tech-lead | Date: 2026-03-25 | Score: 4.5/5

### Decomposition alternatives considered

- **Flat vs layered steps**: considered grouping all agents (T1.4–T1.7) into a single "DAG + Agents" step — rejected because DAG Executor (T1.4) is a hard dependency for agents, and T1.6/T1.7 can run in parallel. Splitting preserves parallelization opportunity.
- **T1.8 placement**: considered placing EventBus after T1.9 (LLM routing) for a "complete data flow" ordering — rejected. EventBus is a convergence point for T1.3 (Auth) + T1.5 (DAG) + T1.6 + T1.7, and T1.9 needs the SSE infrastructure to be in place for streaming. Correct order: T1.8 → T1.9.
- **Frontend-heavy tasks (T3.1, T2A.2, T2A.3, T3.3)**: considered splitting into separate frontend/backend steps — kept as backend-scoped steps with explicit "Backend scope" annotation and narrow subtask lists. Frontend components are noted as out of scope.
- **T3.8 + T3.9 merge**: considered merging supply-chain security and security hardening into one step — rejected. T3.8 is additive (verifying existing install-pack.ts), T3.9 is invasive (ESLint + exec migration across all files). Keeping them separate avoids scope creep in T3.8.

### Non-obvious dependencies discovered

- **T1.8 is a 4-way convergence**: Steps 3 (Auth) + 5 (DAG parallel) + 6 (Classifier/Planner) + 7 (Writer/Reviewer) must ALL be complete before T1.8. This is the riskiest coordination point.
- **T1.9 depends on T1.8 (not just T1.3)**: the LLM routing layer needs the SSE infrastructure (EventBus + routes) to be in place for streaming tokens to clients. T1.9 cannot run before T1.8.
- **T2A.4 (EvalAgent) depends on T2A.3 (Critical Reviewer)**: they share a merged gate (Am.94.2). EvalAgent cannot be implemented standalone.
- **T3.8 (supply chain) must precede T3.9 finalization**: T3.9 adds `gitleaks` and CI SHA pinning which extend T3.8 work. Doing T3.9 first would mean rewriting CI workflows twice.
- **T1.5 before T1.6 AND T1.7**: both agent steps depend on the `MockLLMClient` (created in T1.4) and the parallel executor (T1.5). Skipping T1.5 would leave agents without crash recovery wiring.

### Steps at risk

- **Step 2 — T1.2 Prisma schema**: largest schema in the project; Better Auth CLI merge is error-prone (manual edit of `schema.prisma`). High risk of missing amendment fields (Am.63/64/65/78/79/80/83/85/86/87). Verification rubric threshold set at 4.5 to catch regressions early.
- **Step 8 — T1.8 EventBus + SSE**: 4-way convergence point; most file surface area (10 subtasks). If any upstream step is incomplete, T1.8 is blocked. SSE permission filtering (Am.78.6) is easy to skip under time pressure.
- **Step 9 — T1.9 LLM routing**: external provider integration — API key validity, rate limits, provider-specific quirks (Ollama URL detection). Integration test with real Haiku is the riskiest test in Phase 1.
- **Step 25 — T3.9 Security hardening**: broad scope (12 subtasks). Risk of partial implementation — every `exec()` call in the codebase must be audited. ESLint rule is the safety net, but must be configured correctly in T1.1 (Step 1).

### Notes for P6 (team-lead)

- **Steps 6 + 7 in parallel**: both depend only on Step 5 (T1.5). Assign to two developers simultaneously.
- **Steps 10, 11, 12, 13 in parallel**: all depend only on Step 9 (T1.9). All 4 can run simultaneously in Phase 2A.
- **Steps 15 + 16 in parallel**: T2B.1 and T2B.2 both depend on Step 8. No cross-dependency.
- **Steps 17–24 mostly parallel**: after Steps 9 + 15 are green, Steps 17–24 have no inter-dependencies except Step 24 (T3.8) → Step 25 (T3.9).
- **Validation checkpoints are hard stops**: Steps 9, 10/T2A.1, 15/T2B.1 each require human approval. P6 must schedule these as explicit milestones, not just "done" marks.

### Open questions

(Score 4.5 — no blocking questions)

- `orchestrator.yaml` full JSON schema for platform detection rules (Step 11) — to be defined in T1.1 but format not fully specified
- EvalAgent sprint contract format (Step 14) — Am.89 describes behavior but rubric field structure is implicit
- Electron `electron/auto-updater.ts` SQLite backup path convention — not specified in TECHNICAL.md; to confirm at T3.6 implementation time

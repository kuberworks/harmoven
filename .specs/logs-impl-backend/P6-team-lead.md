## Agent: team-lead | Date: 2026-03-25 | Score: 4.5/5

### Parallelization opportunities found

- **Steps 3 + 4** (T1.3 Auth + T1.4 DAG core): both depend only on Step 2 (Schema). Can start simultaneously — no shared files. Saves ~1 week on critical path.
- **Steps 6 + 7** (T1.6 Classifier/Planner + T1.7 Writer/Reviewer): both depend only on Step 5. No shared files (Step 6 owns `agent.interface.ts`). Saves ~3-4 days.
- **Steps 10–13** (T2A.1–T2A.3): all depend only on Step 9 (T1.9). All 4 simultaneously = full Phase 2A in ~1 week instead of 2. Biggest gain in absolute time.
- **Steps 15 + 16** (T2B.1+T2B.2): same starting gate (Step 8), no schema dependency between them. Clean parallel.
- **Steps 17–21**: Phase 3 opens up massively — 5 independent tasks all unblocked at the same time once Steps 8+9 are green.
- **Steps 22 + 23**: Update management and i18n are completely orthogonal — no shared files at all.

### Hard sequencing constraints

1. **T1.1 → T1.2 → T1.3/T1.4**: schema is a global dependency. No workaround — every model depends on `prisma/schema.prisma`.
2. **T1.4 → T1.5**: crash recovery and heartbeat extend the same `executor.ts`. Cannot split — they modify the same file in ways that would conflict if parallelized.
3. **Steps 3+5+6+7 → Step 8**: the 4-way convergence. Auth session is needed for SSE permission filtering; DAG executor emits through the bus; Classifier + Writer are the first consumers of SSE events. All four must be complete before the connection layer is wired.
4. **Step 13 → Step 14**: EvalAgent and Critical Reviewer share a merged gate UI (Am.94.2). EvalAgent's `lib/agents/eval/` reads Critical Reviewer findings. Strict sequential required.
5. **Steps 19+21 → Step 24 → Step 25**: GPG/SHA hardening must be applied to completed install-pack.ts and CI workflows, not partial files.

### Coordination risks

- **`agent.interface.ts` ownership conflict** (Steps 6+7 parallel): resolved by assigning `IAgentRunner` interface ownership to Step 6. Step 7 imports and never redefines. Must be documented explicitly in P8 prompt for T1.6.
- **Step 8 partial convergence**: if Step 6 finishes before Step 7 (or vice versa), a developer might be tempted to start Step 8 early with partial agent coverage. This is a coordination risk — Step 8 must wait for both Step 6 AND Step 7 to reach threshold 4.0+ in their verification rubrics.
- **Migrations in parallel phases**: Steps 15 (T2B.1) creates a new Prisma migration while Phase 2A steps (10–14) are also running. These steps don't touch migrations, so no conflict — but the P8 developer for Step 15 should be aware of the concurrent branches.
- **CI workflows**: Step 21 creates the workflow files; Step 24 pins SHAs into them. If CI is run between Steps 21 and 24, unpinned actions may trigger a supply-chain audit failure. Mitigation: mark Step 24 as "must immediately follow Step 21" with zero intermediate CI runs.

### Notes for P7 (qa-engineer)

- **All 25 steps already have `#### Verification` rubrics** from P5. P7 should review and upgrade any that are below Panel-of-2 for security/schema-critical steps. In particular:
  - Step 3 (T1.3 Auth): verify threshold is 4.5, Panel of 2 ✓
  - Step 8 (T1.8 SSE + API): verify threshold is 4.5, Panel of 2 ✓
  - Step 15 (T2B.1 RBAC): verify threshold is 4.5, Panel of 2 ✓
  - Step 25 (T3.9 Security): verify threshold is 4.5, Panel of 2 ✓
- **Steps 6 + 7 parallel** should have an integration verification step at the start of Step 8 that validates the combined agent surface (not just individual tests).
- **Step 10 (T2A.1)** has Puppeteer — this is inherently flaky in CI. DoD should note: "Puppeteer tests run in integration tier, not unit tier. Allowed to be skipped in PR pipeline, required in main pipeline."
- **Validation checkpoint gates** (after Steps 9, 10/T2A.1, 15/T2B.1, 25) are human-approval steps. The DoD should distinguish "automated verification passed" from "human approval given". P7 must add this distinction explicitly in the global DoD.

### Open questions

(Score 4.5 — no blocking questions)

- Solo developer vs 2-developer team: the execution plan assumes 2 developers for parallel steps. If solo, the parallel opportunities reduce to sequential — add 4–5 weeks. P7/P8 should note this assumption explicitly.
- CI environment for Puppeteer (Step 10): flakiness mitigation strategy (retry count, headless config) — to be defined at T2A.1 implementation time.

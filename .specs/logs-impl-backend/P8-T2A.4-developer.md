# P8-T2A.4 — EvalAgent (Amendment 89)
**Agent**: developer  
**Date**: 2026-03-27  
**Score**: 5 / 5  

---

## What was implemented

### Files created
| File | Purpose |
|---|---|
| `lib/agents/eval/eval.types.ts` | `SprintContract`, `EvalCriterion`, `ScoredCriterion`, `EvalAgentOutput`, `EvalVerdict`, `EvalResultRecord` |
| `lib/agents/eval/eval-rubrics.ts` | Domain rubrics for 7 profiles + `GENERIC_RUBRIC` fallback; `getRubricForProfile()` |
| `lib/agents/eval/eval.agent.ts` | `negotiateSprintContract()` + `evaluate()` — full retry loop, hard-fail detection, emergency pass |
| `components/gate/EvalTab.tsx` | Human Gate read-only eval tab — score ring, per-criterion bars, attempt pips, feedback panel |
| `prisma/migrations/20260326130000_add_eval_result_am89/migration.sql` | `EvalResult` table (run_id FK, node_id, attempt, overall_score, passed, criteria JSON, feedback) |
| `tests/agents/eval/eval.agent.test.ts` | 38 unit tests — rubric integrity, weight normalisation, scoring, retry logic, hard-fail, edge cases |

### Files not created (already present via T2A.3 agent)
| File | Reason |
|---|---|
| `prisma/schema.prisma` — `EvalResult` model | T2A.3 agent added it alongside `CriticalReviewResult` |

---

## Decisions

### Branch strategy — off `feat/t2a3-critical-reviewer`
T2A.3 had already modified `prisma/schema.prisma`. To avoid a merge conflict, `feat/t2a4-eval-agent` was created from `feat/t2a3-critical-reviewer` (not from `develop`). This means both branches merge cleanly once T2A.3 lands on `develop`.

### Files were staged in `/tmp/harmoven-t2a4/` first
The other agent was working on T2A.3 in the same repo. All files were written to `/tmp/harmoven-t2a4/` to avoid conflicts during creation, then copied in once T2A.3's branch was visible and we could verify no file overlap.

### `verdict = ESCALATE_HUMAN` on last attempt (not `PASS`)
When the output fails on attempt 3, the EvalAgent still sets `passed = true` (so the Human Gate opens) but uses `verdict = ESCALATE_HUMAN` to signal the human that quality did not meet the threshold. This distinction is surfaced in the `EvalTab` as a red warning panel.

### Weight normalisation
If the LLM returns criteria whose weights don't sum to 1.0, the agent normalises them. This makes the sprint contract negotiation resilient to LLM rounding errors without rejecting otherwise valid responses.

### Emergency pass on malformed LLM response
If the EvalAgent's own LLM call returns invalid JSON, the output is `verdict = ESCALATE_HUMAN, passed = true, overall_score = 0.5`. This ensures a malformed eval never blocks the pipeline — it always surfaces at the Human Gate.

### Rubric coverage
7 profiles fully specified: `marketing_content`, `app_scaffolding`, `legal_compliance`, `data_reporting`, `finance_modeling`, `hr_recruiting`, `research_synthesis`. All others fall back to `GENERIC_RUBRIC` (4 criteria). The spec asked for 4 — 7 were added to reduce fallback surface.

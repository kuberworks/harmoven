## Agent: qa-engineer | Date: 2026-03-25 | Score: 4.5/5

### Verification levels assigned

All 25 steps already have `#### Verification` rubrics from P5 (tech-lead). Reviewed and confirmed:

| Level | Steps | Reason |
|---|---|---|
| Panel of 2 (threshold 4.5) | Steps 2, 3, 8, 9, 14, 15, 24, 25 | Schema, Auth, SSE convergence, LLM routing, EvalAgent, RBAC, supply chain, security hardening |
| Single Judge (threshold 4.0) | Steps 1, 4, 5, 6, 7, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23 | Standard complexity steps |

Rubric upgrades applied:
- **Step 3 (T1.3)**: confirmed Panel of 2, threshold 4.5. Added explicit criterion: `cookieCache: { enabled: false }` verified (force-revocation).
- **Step 8 (T1.8)**: confirmed Panel of 2, threshold 4.5. Permission filtering verification (`viewer` cannot see `cost_update`) already in rubric — no change needed.
- **Step 9 (T1.9)**: confirmed Panel of 2, threshold 4.5. Integration test with real Haiku is the riskiest criterion — threshold already reflects this.
- **Step 25 (T3.9)**: confirmed Panel of 2, threshold 4.5. Broad scope but rubric criteria are concrete (ESLint rule active, `assertNotPrivateHost()` verified, ephemeral vault tested).

No rubric needed upgrading above Panel of 2 — the current set is appropriate for the risk level of each step.

### DoD items that are not automatable (require human review)

- **Human approval gates** (4 checkpoints): after Steps 9, 10, 15, and final E2E. These are explicitly marked in the DoD as `✋` items. No CI check can substitute — they require a human to evaluate the running system.
- **UX/UI frontend contracts**: the DoD verifies that `types/*.ts` are exported and consistent, but cannot verify that the frontend team actually uses them correctly. This is a coordination item, not a code quality item.
- **Magic link email delivery**: in CI, a mock SMTP (MailHog or similar) is used. Real email delivery is validated manually in staging only.
- **Puppeteer screenshots (Step 10)**: Puppeteer tests are excluded from the PR pipeline (flakiness risk) and run only in the `main` pipeline. Human reviews the generated screenshots. This is noted in the DoD under Step 10.
- **`ENCRYPTION_KEY` isolation**: the invariant that `ENCRYPTION_KEY` is never co-located with `DATABASE_URL` in production cannot be tested in CI (CI uses test env). Validated manually via `.env.example` review.

### Risks of false positives

- **Panel of 2 self-scoring** (Steps 2, 3, 8): if the same agent both implements and validates, the score may be inflated. Mitigation: P8 prompts should instruct the developer agent to use a "fresh context" for self-verification (re-read the spec, don't rely on implementation memory).
- **`npm audit` criterion**: `npm audit` reports only known CVEs at the time of check. New CVEs published after the check are not caught. Mitigation: `npm audit` is also run in CI on a schedule (not only at build time).
- **Integration test with real Haiku (Step 9)**: if Haiku API is rate-limited or slow, the test may fail non-deterministically. Mitigation: the test should have a 30s timeout with 2 retries and log the failure reason clearly.
- **gitleaks scan (Step 25)**: gitleaks config must explicitly include the `lib/agents/scaffolding/` path. A too-narrow scope would produce a green result without actually scanning generated worktrees.

### Notes for P8 (developer)

Steps with the strictest thresholds (Panel of 2, threshold 4.5) in execution order:
1. **Step 2** — T1.2 Prisma schema. Verify ALL amendment fields are present before marking done.
2. **Step 3** — T1.3 Better Auth. Verify 7 built-in roles seeded; `emailVerified` bootstrap exception works; `cookieCache: { enabled: false }` confirmed.
3. **Step 8** — T1.8 EventBus + SSE. Do NOT start until Steps 3, 5, 6, AND 7 all show threshold ≥ 4.0.
4. **Step 9** — T1.9 LLM routing. The integration test with real Haiku is the gate for Phase 2 — do not skip it under time pressure.
5. **Step 15** — T2B.1 RBAC. Dual-write migration: verify no data loss by checking row counts before and after each of the 3 migration steps.
6. **Step 25** — T3.9 Security hardening. Run ESLint with the new rule BEFORE starting implementation to get a baseline count of `exec()` calls to fix.

### Open questions

(Score 4.5 — no blocking questions)

- MailHog vs Resend mock in CI: the DoD marks magic link as "can use mock SMTP in CI" — the specific mock library is not prescribed. P8 for Step 3 should confirm and document this in `claude-progress.txt`.
- Puppeteer version pinning (Step 10): Puppeteer updates can break screenshot generation. Should be pinned in `package.json` alongside Better Auth. P8 for Step 10 should pin it.

# .specs — Task & Spec Workflow

This folder contains all agent-managed specifications, task files, and implementation logs for Harmoven.

---

## Folder structure

```
.specs/
  tasks/
    todo/           Feature specs ready to implement (never touched yet)
    draft/          Specs being refined before implementation
    implemented/    Completed specs — kept for reference and audit trail
  analysis/
    codebase-impact.md          Initial codebase survey (code-explorer agent)
    architecture-review.md      Architecture & security audit
  logs/             Agent execution logs — frontend implementation phase
  logs-impl-backend/  Agent execution logs — backend implementation phase
```

---

## Task lifecycle

```
draft/ ──► todo/ ──► [implementation] ──► implemented/
```

1. **draft/** — spec is being written or refined; not yet stable
2. **todo/** — spec is frozen, ready for an implementation agent to pick up
3. **implemented/** — feature is shipped; file kept for traceability

---

## Spec file format

Each `.feature.md` file has a YAML frontmatter block:

```yaml
---
title: <human-readable title>
depends_on: [<other feature slug>, ...]
created: YYYY-MM-DD
status: todo | draft | implemented
agents_completed: [researcher, code-explorer, ...]
agents_pending: []
---
```

Followed by structured sections: **Research Findings**, **Acceptance Criteria**, **Implementation Plan**, **Test Plan**.

---

## Current tasks

| File | Status |
|---|---|
| `.specs/tasks/implemented/harmoven-v1-implementation.feature.md` | implemented |
| `.specs/tasks/implemented/marketplace-v2.feature.md` | implemented |
| `.specs/tasks/implemented/marketplace-v2.feature.md` | implemented |

---

## Logs

Agent execution logs are stored per-phase under `logs/` and `logs-impl-backend/`. Each file is named `P<phase>-<task>-<agent>.md` and contains the full agent turn for auditability. These are reference-only — do not modify them.

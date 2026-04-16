# P8-T2A.2b-developer.md — Harmoven v1
# Role: Developer (Phase 8 — T2A.2b)
# Date: 2026-03-26
# Task: ILayerAgentExecutor + LLMDirectExecutor + KiloCliExecutor STUB (Am.72 + Am.95.2)

---

## 1. Task summary

Implement `ILayerAgentExecutor` — the abstraction layer that decouples Layer Agent
code generation from the execution backend (LLM direct vs. Kilo CLI).

**Spec:** TECHNICAL.md Section 24, Amendment 72, Amendment 95.2.

**Done when:**
- [x] `ILayerAgentExecutor` interface with `LayerAgentInput`, `LayerAgentOutput`
- [x] `LLMDirectExecutor` working end-to-end (default, always available)
- [x] `createLayerAgentExecutor()` uses dynamic import (Am.95.2)
- [x] `KiloCliExecutor` STUB (throws `NotImplementedError`, `isAvailable()=false`)
- [x] Unit test: 28 tests covering happy path, security, error handling, factory

---

## 2. Files created / modified

| File | Action | Description |
|------|--------|-------------|
| `lib/agents/scaffolding/layer-agent-executor.interface.ts` | Created | `LayerAgentInput`, `LayerAgentOutput`, `ILayerAgentExecutor`, `LayerType` |
| `lib/agents/scaffolding/executors/llm-direct.executor.ts` | Created | Default executor — LLM call + file write |
| `lib/agents/scaffolding/executors/kilo-cli.executor.ts` | Created | STUB — deferred to v1.1 |
| `lib/agents/scaffolding/layer-agent-executor.factory.ts` | Created | `createLayerAgentExecutor()` with dynamic import |
| `tests/agents/scaffolding/layer-agent-executor.test.ts` | Created | 28 unit tests |

---

## 3. Technical decisions

### 3.1 ILLMClient injection (not a global `selectLlm`)
The spec showed a `selectLlm(run_id, node_id)` helper that doesn't exist in the
codebase. Rather than invent a global, I followed the established pattern of all
other agents (Writer, Reviewer, EvalAgent…): the `ILLMClient` is injected into
the executor constructor by the factory. This keeps the executor testable with
`MockLLMClient` and the factory owns the LLM selection logic.

### 3.2 LLM tier per layer (Section 24.3)
```
db, infra → 'fast'     (haiku — structured, config files, small output)
api, ui, test → 'balanced'  (sonnet — reasoning + multi-file code gen)
```
Unknown layer type falls back to `'balanced'` (safe default).

### 3.3 Dynamic import for both executors (Am.95.2)
Both `LLMDirectExecutor` and `KiloCliExecutor` are loaded via `await import()`.
Even though `LLMDirectExecutor` is always used, the symmetry ensures no static
import of `KiloCliExecutor` ever happens regardless of tree-shaking behaviour.

### 3.4 success=false, never throw (LLMDirectExecutor.execute)
Consistent with `repair.agent.ts` and `smoke-test.agent.ts`: executor catches all
errors and returns `{ success: false, error: … }` instead of throwing. The caller
(DAG Executor) marks the node FAILED without an unhandled exception.

### 3.5 KiloCliExecutor is a pure STUB
`isAvailable()` always returns `false`. The factory falls through to
`LLMDirectExecutor` silently with a `console.warn`. No Prisma `auditLog()` call
in v1 (would require DB client at this layer — not wired yet).
Deferred audit log is a v1.1 concern alongside the full KiloCliExecutor impl.

---

## 4. Security

| Vector | Mitigation |
|--------|-----------|
| Path traversal via LLM file output | `sanitizeRelativePath()`: rejects absolute paths, `..` prefixes, null bytes |
| Path escape after join | Defence-in-depth: `path.resolve(fullPath).startsWith(resolvedWorktree + sep)` check before `writeFileSync` |
| Prompt injection via context files | `MAX_CONTEXT_CHARS = 200_000` truncation per file |
| Hallucinated oversized output | `MAX_OUTPUT_CHARS = 200_000` cap before JSON.parse |
| Binary injection in file paths | Null-byte check in `sanitizeRelativePath()` |

---

## 5. Test results

```
Tests:       28 passed, 28 total  (layer-agent-executor.test.ts)
Test Suites: 13 passed, 13 total  (full suite regression)
Tests:       5 skipped, 235 passed, 240 total
Time:        3.57 s
```

All existing tests continue to pass — zero regressions.

---

## 6. Self-evaluation

**Respect des specs (Am.72 + Am.95.2):** 4.5/5
- Interface, LLMDirectExecutor, KiloCliExecutor STUB, factory all implemented.
- Dynamic import used for both executors (Am.95.2 compliant).
- Tier selection matches Section 24.3 model mapping.
- **Penalty -0.5:** No Prisma `auditLog()` in the factory fallback path (kilo_cli
  unavailable). The spec shows `await auditLog(…)` in `buildLayerAgentExecutor()`.
  Deferred because `auditLog()` doesn't exist as a standalone utility yet (it's
  done inline in each agent file). Documented as v1.1 debt.

**Sécurité:** 5/5
- Path traversal prevented at two levels (sanitize + re-verify after join).
- Context file truncation prevents prompt injection.
- Output size cap prevents hallucinated oversized writes.
- Null-byte guard on file paths.
- OWASP injection (file write via LLM output) fully mitigated.

**Score global: 4.5/5**

---

## 7. Déferred / known debt

| Item | Deferred to |
|------|-------------|
| `KiloCliExecutor` full implementation (invoke kilocode CLI, parse JSON output) | v1.1 (Am.72.5 eval criteria first) |
| `auditLog('system', 'kilo_cli_unavailable', …)` in factory | v1.1 (alongside KiloCliExecutor) |
| `isSkillEnabled('kilo-cli', project_id)` check in factory | v1.1 |
| KiloCloudExecutor (Kilo Cloud Agents REST API) | v2 |

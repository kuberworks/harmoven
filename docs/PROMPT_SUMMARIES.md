// docs/PROMPT_SUMMARIES.md
# Prompt Summaries — Amendment 86

## Problem Statement

After a run completes, users want to review **what each agent was asked** (the prompts).

However, storing full prompts presents challenges:
- **Storage cost**: 5 MB/day for average 50 runs (2 KB prompts × 5 agents)
- **GDPR liability**: Prompts contain `task_input` (user data that must be deleted on request)
- **Retention burden**: Data retention policies require TTL enforcement
- **Data quality**: Prompts change when code is updated, making historical prompts stale

## Solution: Lightweight Execution Context (Amendment 86)

Instead of storing full prompts, capture **execution context**—the minimal data needed for audit + transparency.

### What is Captured

Per node execution, we store:

```jsonc
{
  // Execution snapshot (ALWAYS)
  "node_id": "n3",
  "agent_type": "WRITER",
  "domain_profile": "app_scaffolding",  // as determined at execution time
  
  "execution_context": {
    // What was being asked?
    "profile_detected_at": "CLASSIFIER",  // which agent determined the profile
    "complexity": "high",                  // low | medium | high
    "expected_output_type": "code",       // what was expected
    "task_input_truncated": "Build a React component for...",  // first 200 chars only
    
    // What did it receive from upstream?
    "upstream_nodes": [
      {
        "node_id": "n1",
        "agent_type": "PLANNER",
        "content_hash": "sha256:abc123..."  // hash of handoff_out
      },
      {
        "node_id": "n2",
        "agent_type": "PLANNER",
        "content_hash": "sha256:def456..."
      }
    ]
  },
  
  // Cost tracking
  "estimated_tokens_in": 450,   // our pre-execution estimate
  "estimated_tokens_out": 2048, // based on output_type
  "token_actual": {             // vs actual usage
    "tokens_in": 432,
    "tokens_out": 2156
  },
  
  // Audit trail
  "upstream_handoff_hash": "sha256:xxx...",  // for integrity checking
  "status": "COMPLETED",
  "error": null,
  "retries": 0,
  "created_at": "2026-04-05T13:26:13Z",
  "cost_usd": 0.0234
}
```

### What is NOT Stored

- ❌ Full system prompts (e.g. "You are a Harmoven Writer agent...")
- ❌ Full user messages
- ❌ LLM responses (already in Node.handoff_out if needed)
- ❌ Credentials / confidential context

### Why This Works

**For Audit Trail:**
- Users can see exactly what profile/complexity each agent used
- `task_input_truncated` gives context clues
- `upstream_nodes` shows dependency chain

**For Cost Optimization:**
- Compare `estimated_tokens_*` vs `token_actual` to improve estimates
- Identify which agents over-consume tokens

**For Debugging:**
- If a run failed, reconstruct "what likely happened" from context
- Verify integrity: hash of upstream outputs matches

**For Compliance:**
- No full prompts = smaller GDPR deletion scope
- `task_input_truncated` (200 chars) is anonymizable
- TTL can still be enforced on the PromptSummary table itself

## API Usage

### Retrieve Execution Context

```http
GET /api/runs/{runId}/prompt-summaries

{
  "run_id": "...",
  "run_status": "COMPLETED",
  "prompt_summaries": [
    {
      "node_id": "n1",
      "agent_type": "CLASSIFIER",
      "domain_profile": "app_scaffolding",
      "execution_context": { ... },
      "status": "COMPLETED",
      "snapshot_created_at": "2026-04-05T13:26:13Z"
    },
    ...
  ]
}
```

### Database Schema

```sql
CREATE TABLE "PromptSummary" (
  "id" TEXT PRIMARY KEY,
  "run_id" TEXT NOT NULL REFERENCES "Run"("id"),
  "node_id" TEXT NOT NULL,  -- "n1", "n2"
  "agent_type" TEXT NOT NULL,
  "domain_profile" TEXT NOT NULL,
  "execution_context" JSONB NOT NULL,  -- see above
  "estimated_tokens_in" INTEGER,
  "estimated_tokens_out" INTEGER,
  "upstream_handoff_hash" TEXT,
  "serialization_version" TEXT NOT NULL DEFAULT '1.0',
  "created_at" TIMESTAMP DEFAULT NOW(),
  
  UNIQUE("run_id", "node_id"),
  INDEX("run_id"),
  INDEX("node_id")
);
```

## Implementation Details

### Capture Mechanism

`PromptSummaryCaptureClient` wraps the actual LLM client:

```typescript
export function makeAgentRunner(llm: ILLMClient): AgentRunnerFn {
  return async (node, handoffIn, signal, onChunk) => {
    // Wrap with capture client
    const captureClient = new PromptSummaryCaptureClient(llm, ...)
    
    // Set context before execution
    const upstreamNodes = await getUpstreamNodes(run, node)
    captureClient.setUpstreamNodes(upstreamNodes)
    captureClient.setComplexity(meta.complexity)
    captureClient.setExpectedOutputType(meta.expected_output_type)
    
    // Run agent (agent calls captureClient.chat / captureClient.stream normally)
    const result = await new Writer(captureClient).execute(...)
    
    // After execution completes, captureClient automatically:
    // 1. Builds execution_context snapshot
    // 2. Persists to PromptSummary table
    // 3. Non-blocking (failures don't break runs)
    
    return result
  }
}
```

**Key design:** Capture is **after execution**, so no performance impact or blocking.

### Error Handling

If `db.promptSummary.create()` fails (DB down, etc):
- Run continues normally ✅
- Error logged: `console.warn('[PromptSummary] failed to persist...')`
- No user-facing impact

This is intentional—audit is nice-to-have, not critical path.

## Limitations & Trade-offs

| Aspect | Full Prompts | PromptSummary |
|---|---|---|
| **Storage** | 5 MB/day | 100 KB/day |
| **Accuracy** | 100% | ~70% (truncated input, hashes) |
| **Reconstruction** | Exact replay possible | Approximate only |
| **GDPR friendly** | ❌ Complex | ✅ Simple |
| **Cost tracking** | Precise | Estimates vs actual |
| **Compliance audit** | Full context | Sufficient for most cases |

## Future Enhancements

- [ ] Add full prompt log to optional GCS archive (for compliance investigations)
- [ ] Rebuild prompts on-demand from context (for transparency demos)
- [ ] Cost prediction accuracy tracking
- [ ] Token usage analytics per agent/profile

// lib/agents/runner.ts
// Production AgentRunnerFn — dispatches to the correct agent class based on node.agent_type.
// Wired into createExecutionEngine() as the default agentRunner.
//
// Node metadata contract (written when nodes are persisted from Planner output):
//   WRITER:           { description, complexity, expected_output_type, domain_profile, task_type? }
//   REVIEWER:         { domain_profile }
//   PLANNER:          { task_input? }
//   CLASSIFIER:       handoffIn = string | { input: string }
//   SMOKE_TEST:       { worktree, routes?, timeout_s? }
//   REPAIR:           { worktree, subpath } — used standalone (smoke-test integrates repair internally)
//   CRITICAL_REVIEW:  { domain_profile, run_config_severity?, project_severity?, preset? }
//
// Selection context (optional, also from node metadata):
//   { confidentiality?, jurisdiction_tags?, preferred_llm?, estimated_tokens? }
//   When present, DirectLLMClient routes via selectLlm() instead of selectByTier().

import type { AgentOutput, AgentRunnerFn, NodeRow } from '@/lib/execution/engine.interface'
import type { ILLMClient, ChatMessage, ChatOptions, ChatResult } from '@/lib/llm/interface'
import { IntentClassifier } from '@/lib/agents/classifier'
import type { ClassifierResult, ProfileId } from '@/lib/agents/classifier'
import { Planner } from '@/lib/agents/planner'
import { Writer } from '@/lib/agents/writer'
import type { WriterNodeInput } from '@/lib/agents/writer'
import { Reviewer } from '@/lib/agents/reviewer'
import type { WriterOutput } from '@/lib/agents/writer'
import { runSmokeTest } from '@/lib/agents/scaffolding/smoke-test.agent'
import { repairForSubpath } from '@/lib/agents/scaffolding/repair.agent'
import { CriticalReviewer } from '@/lib/agents/critical-reviewer'
import { resolveCriticalSeverity } from '@/lib/agents/reviewer/critical-reviewer.types'
import { PromptSummaryCaptureClient } from '@/lib/agents/prompt-summary'
import { db } from '@/lib/db/client'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_PROFILES = new Set<string>([
  'data_reporting', 'app_scaffolding', 'document_drafting', 'research_synthesis',
  'marketing_content', 'hr_recruiting', 'legal_compliance', 'finance_modeling',
  'customer_support', 'ecommerce_ops', 'training_content', 'generic',
])

// Whitelist of allowed agent_type values (#13 — DAG agent_type validation).
// Checked before the switch so a tampered DB row or DAG JSON cannot reach
// an unintended code path via a case-folding variant.
const ALLOWED_AGENT_TYPES = new Set([
  'CLASSIFIER', 'PLANNER', 'WRITER', 'REVIEWER',
  'SMOKE_TEST', 'REPAIR', 'CRITICAL_REVIEW',
])

function asProfileId(v: unknown): ProfileId {
  if (typeof v === 'string' && VALID_PROFILES.has(v)) return v as ProfileId
  return 'generic'
}

/**
 * Sanitize a user-supplied task description before passing it to a Planner or Classifier.
 *
 * Context: task_input is authored by an authenticated user (not an external attacker), so the
 * real risk here is *jailbreak* — a user crafting a prompt that overrides the Planner's
 * system prompt and causes it to emit a malicious DAG (e.g. agent_type = "SHELL",
 * arbitrary tool calls, exfiltration instructions).
 *
 * Strategy (complementary layers):
 *   1. Strip null bytes and non-whitespace C0/C1 control characters (same as Writer).
 *   2. Normalise unicode to NFC to prevent homoglyph bypasses.
 *   3. Detect common role-override openers and replace with a placeholder.
 *      We intentionally do NOT replace the entire string — legitimate tasks may mention
 *      "ignore previous X" in a completely innocuous business context. We strip only
 *      the injection token itself, preserving the rest.
 *   4. Hard cap: 10 000 characters (prompt flooding defence).
 *   5. JSON / array task_input: serialized to string before scanning so injection
 *      patterns embedded in object values are also caught.
 *
 * Note: full jailbreak prevention at the prompt level is an arms race; the primary
 * structural defence is the downstream DAG validation in Planner.validateDag()
 * (agent whitelist, cycle detection, depth limit) which rejects structurally invalid
 * plans regardless of what the LLM produces.
 */
// Primary role-override / context-reset patterns.
const TASK_INJECTION_RE = /\b(ignore|forget|disregard|override|cancel)\s+(previous|prior|above|all)\s+(instructions?|rules?|context|prompt)/gi
// Extended patterns: role-hijacking openers, instruction replacement, and LLM special tokens.
const TASK_ROLE_INJECTION_RE = /\b(act\s+as|you\s+are\s+now|pretend\s+(?:to\s+be|you\s+are)|from\s+now\s+on\s+you|(?:new|updated)\s+instructions?\s*:)\b|<\/?(?:system|human|assistant)>/gi
const MAX_TASK_INPUT_CHARS = 10_000

// Accepts any input type — JSON objects and arrays are serialised so injection
// patterns embedded in nested string values are caught before the LLM sees them.
function sanitizeTaskInput(raw: unknown): string {
  const str = typeof raw === 'string'
    ? raw
    : raw !== null && raw !== undefined
      ? JSON.stringify(raw)
      : ''
  return str
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    .normalize('NFC')
    .replace(TASK_INJECTION_RE, '[REDACTED]')
    .replace(TASK_ROLE_INJECTION_RE, '[REDACTED]')
    .slice(0, MAX_TASK_INPUT_CHARS)
}

// ─── ContextualLLMClient ──────────────────────────────────────────────────────

/**
 * Wraps an ILLMClient to inject per-node selection context into every call.
 * This enables multi-criteria routing (selectLlm) in DirectLLMClient for nodes
 * that carry confidentiality/jurisdiction/budget constraints in their metadata.
 * Agents never need to be aware of this — they just call llm.chat() as normal.
 *
 * Also accumulates total costUsd / tokensIn / tokensOut across all calls made
 * during a single node execution so runner.ts can report accurate per-node cost.
 */
class ContextualLLMClient implements ILLMClient {
  totalCostUsd = 0
  totalTokensIn = 0
  totalTokensOut = 0
  /** Set to the model string returned by the last successful LLM call (e.g. "claude-opus-4-5-20251001"). */
  lastModel: string | null = null

  constructor(
    private readonly inner: ILLMClient,
    private readonly ctx: ChatOptions['selectionContext'],
  ) {}

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const result = await this.inner.chat(messages, { ...options, selectionContext: this.ctx })
    this.totalCostUsd   += result.costUsd
    this.totalTokensIn  += result.tokensIn
    this.totalTokensOut += result.tokensOut
    if (result.model) this.lastModel = result.model
    return result
  }

  async stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
  ): Promise<ChatResult> {
    const result = await this.inner.stream(messages, { ...options, selectionContext: this.ctx }, onChunk)
    this.totalCostUsd   += result.costUsd
    this.totalTokensIn  += result.tokensIn
    this.totalTokensOut += result.tokensOut
    if (result.model) this.lastModel = result.model
    return result
  }
}

// ─── makeAgentRunner ──────────────────────────────────────────────────────────

/**
 * Build the real AgentRunnerFn for production.
 * Pass the result to createExecutionEngine({ agentRunner }).
 *
 * @param llm The ILLMClient to use (typically from createLLMClient()).
 */
export function makeAgentRunner(llm: ILLMClient): AgentRunnerFn {
  return async (node: NodeRow, handoffIn: unknown, signal: AbortSignal, onChunk?: (chunk: string) => void): Promise<AgentOutput> => {
    const meta = (typeof node.metadata === 'object' && node.metadata !== null
      ? node.metadata
      : {}) as Record<string, unknown>

    // Build per-node selection context from metadata so DirectLLMClient can
    // apply hard constraints (confidentiality, jurisdiction) via selectLlm().
    const selectionContext: ChatOptions['selectionContext'] = {
      task_type:        meta['task_type'] as string | undefined,
      complexity:       meta['complexity'] as 'low' | 'medium' | 'high' | undefined,
      estimated_tokens: typeof meta['estimated_tokens'] === 'number'
        ? (meta['estimated_tokens'] as number)
        : undefined,
      confidentiality:  meta['confidentiality'] as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined,
      jurisdictionTags: Array.isArray(meta['jurisdiction_tags'])
        ? (meta['jurisdiction_tags'] as string[])
        : undefined,
      preferredLlmId:   meta['preferred_llm'] as string | undefined,
    }

    // Wrap llm to carry the per-node context — agents call llm.chat() normally.
    const contextualLlm = new ContextualLLMClient(llm, selectionContext)

    // Amendment 86: Wrap with PromptSummaryCapture to snapshot execution context
    // after each agent completes (without storing full prompts).
    const captureClient = new PromptSummaryCaptureClient(
      contextualLlm,
      node.run_id,
      node.node_id,
      node.agent_type,
      typeof node.metadata === 'object' && node.metadata !== null
        ? asProfileId((node.metadata as Record<string, unknown>).domain_profile)
        : 'generic',
    )

    // Helper to fetch upstream node info for context snapshot
    const getUpstreamNodes = async () => {
      const allNodes = await db.node.findMany({
        where: { run_id: node.run_id },
        select: { node_id: true, agent_type: true, handoff_out: true },
      })
      // Find nodes that feed into this one (based on DAG edges)
      const run = await db.run.findUnique({ where: { id: node.run_id }, select: { dag: true } })
      const dag = (run?.dag as any) ?? { edges: [] }
      const upstreamEdges = (dag.edges || []).filter((e: any) => e.to === node.node_id)
      return allNodes
        .filter(n => upstreamEdges.some((e: any) => e.from === n.node_id))
        .map(n => ({
          node_id: n.node_id,
          agent_type: n.agent_type,
          handoff_out: n.handoff_out,
        }))
    }

    const upstreamNodes = await getUpstreamNodes()
    captureClient.setUpstreamNodes(upstreamNodes)

    // Set additional context for the snapshot
    if (meta['complexity']) captureClient.setComplexity(meta['complexity'] as any)
    if (meta['expected_output_type']) captureClient.setExpectedOutputType(meta['expected_output_type'] as string)
    if (meta['domain_profile']) captureClient.setProfileDetectedAt(node.agent_type)
    if (meta['task_input']) captureClient.setTaskInputTruncated(meta['task_input'])

    const normalizedType = node.agent_type.toUpperCase()

    // #13 — whitelist validation: reject unknown agent types before the switch.
    // This prevents a tampered DAG row from reaching an unexpected code path.
    if (!ALLOWED_AGENT_TYPES.has(normalizedType)) {
      throw new Error(
        `[agentRunner] Unknown agent_type: "${node.agent_type}". `
        + `Allowed: ${[...ALLOWED_AGENT_TYPES].join(', ')}`,
      )
    }

    switch (normalizedType) {

      // ── CLASSIFIER ──────────────────────────────────────────────────────────
      case 'CLASSIFIER': {
        // Extract the task string: prefer the object's `.input` field for object inputs,
        // otherwise pass the raw value (string, array, or object) directly to
        // sanitizeTaskInput which serialises non-strings before scanning.
        const rawInput: unknown = typeof handoffIn === 'string'
          ? handoffIn
          : typeof handoffIn === 'object' && handoffIn !== null && !Array.isArray(handoffIn) &&
              typeof (handoffIn as Record<string, unknown>)['input'] === 'string'
            ? (handoffIn as Record<string, unknown>)['input']
            : (handoffIn !== null && handoffIn !== undefined ? handoffIn : (meta['task_input'] ?? ''))
        // Sanitize before classification: strips control chars, NFC-normalises,
        // and neutralises role-override openers. See sanitizeTaskInput() above.
        const input = sanitizeTaskInput(rawInput)

        const result = await new IntentClassifier(captureClient).classify(input, signal)
        return { handoffOut: result, costUsd: contextualLlm.totalCostUsd, tokensIn: contextualLlm.totalTokensIn, tokensOut: contextualLlm.totalTokensOut, llm_model: contextualLlm.lastModel ?? undefined }
      }

      // ── PLANNER ─────────────────────────────────────────────────────────────
      case 'PLANNER': {
        const classifierResult = handoffIn as ClassifierResult
        // task_input may be stashed in metadata (e.g. when the run was created directly
        // without a CLASSIFIER node). Supports string, JSON object, and array values —
        // non-strings are serialised by sanitizeTaskInput. Fall back to the classifier's
        // input_summary when no metadata task_input is present.
        const rawTaskInput: unknown = meta['task_input'] !== null && meta['task_input'] !== undefined
          ? meta['task_input']
          : (classifierResult?.input_summary ?? '')
        // Sanitize before feeding to the Planner's LLM call. The Planner's structural
        // DAG validation (validateDag) is the primary defence; sanitisation here is
        // defence-in-depth against jailbreak via prompt flooding or role-override.
        const taskInput = sanitizeTaskInput(rawTaskInput)

        const result = await new Planner(captureClient).plan(
          taskInput, classifierResult, node.run_id, signal,
        )
        return { handoffOut: result, costUsd: contextualLlm.totalCostUsd, tokensIn: contextualLlm.totalTokensIn, tokensOut: contextualLlm.totalTokensOut, llm_model: contextualLlm.lastModel ?? undefined }
      }

      // ── WRITER ──────────────────────────────────────────────────────────────
      case 'WRITER': {
        const nodeInput: WriterNodeInput = {
          node_id:              node.node_id,
          description:          (meta['description'] as string | undefined) ?? '',
          complexity:           (meta['complexity'] as WriterNodeInput['complexity'] | undefined) ?? 'medium',
          expected_output_type: (meta['expected_output_type'] as string | undefined) ?? 'document',
          // handoffIn is collected in-memory from upstream nodes via collectHandoffIn().
          // node.handoff_in (the DB field) is intentionally left null — the DB snapshot
          // is not needed because handoffIn is always available in the executor context.
          inputs: (typeof handoffIn === 'object' && handoffIn !== null
            ? handoffIn as Record<string, unknown>
            : {}) as Record<string, unknown>,
          domain_profile: asProfileId(meta['domain_profile']),
          run_id:         node.run_id,
        }

        const result = await new Writer(captureClient).execute(nodeInput, signal, onChunk)
        return {
          handoffOut: result,
          costUsd:   contextualLlm.totalCostUsd,
          tokensIn:  contextualLlm.totalTokensIn,
          tokensOut: contextualLlm.totalTokensOut,
          llm_model: contextualLlm.lastModel ?? undefined,
        }
      }

      // ── REVIEWER ────────────────────────────────────────────────────────────
      case 'REVIEWER': {
        // handoffIn from the executor is either a single WriterOutput or an array
        const writerOutputs: WriterOutput[] = Array.isArray(handoffIn)
          ? (handoffIn as WriterOutput[])
          : handoffIn != null ? [handoffIn as WriterOutput] : []
        const profile = asProfileId(meta['domain_profile'])

        const result = await new Reviewer(captureClient).review(
          writerOutputs, profile, node.run_id, signal,
        )
        return {
          handoffOut: result,
          costUsd:   contextualLlm.totalCostUsd,
          tokensIn:  contextualLlm.totalTokensIn,
          tokensOut: contextualLlm.totalTokensOut,
          llm_model: contextualLlm.lastModel ?? undefined,
        }
      }

      // ── SMOKE_TEST ──────────────────────────────────────────────────────────
      // Runs after DevOps Agent; allocates a port, starts the container, checks
      // routes, resolves preview (subdomain → subpath → screenshots).
      // Container stays alive for the Human Gate; torn down on gate resolution.
      case 'SMOKE_TEST': {
        const worktree = meta['worktree'] as string | undefined
        if (!worktree) throw new Error('[agentRunner] SMOKE_TEST node missing metadata.worktree')

        const result = await runSmokeTest(
          {
            worktree,
            run_id:    node.run_id,
            routes:    Array.isArray(meta['routes']) ? (meta['routes'] as string[]) : undefined,
            timeout_s: typeof meta['timeout_s'] === 'number' ? (meta['timeout_s'] as number) : undefined,
          },
          contextualLlm,
          signal,
        )

        return { handoffOut: result, costUsd: 0, tokensIn: 0, tokensOut: 0, llm_model: contextualLlm.lastModel ?? undefined }
      }

      // ── REPAIR ──────────────────────────────────────────────────────────────
      // Standalone repair node (rare — smoke-test integrates repair internally).
      // Can be used when repair needs to be a separate retryable DAG node.
      case 'REPAIR': {
        const worktree = meta['worktree'] as string | undefined
        const subpath  = meta['subpath'] as string | undefined
        if (!worktree) throw new Error('[agentRunner] REPAIR node missing metadata.worktree')
        if (!subpath)  throw new Error('[agentRunner] REPAIR node missing metadata.subpath')

        await repairForSubpath(worktree, subpath, contextualLlm, signal)
        return { handoffOut: { repaired: true, worktree, subpath }, costUsd: 0, tokensIn: 0, tokensOut: 0, llm_model: contextualLlm.lastModel ?? undefined }
      }

      // ── CRITICAL_REVIEW ─────────────────────────────────────────────────────
      // Runs after Standard Reviewer (APPROVE / APPROVE_WITH_WARNINGS).
      // Skipped if Standard Reviewer issues REQUEST_REVISION.
      // handoffIn: WriterOutput[] (same as REVIEWER)
      // metadata: { domain_profile, run_config_severity?, project_severity?, preset? }
      case 'CRITICAL_REVIEW': {
        const writerOutputs: import('@/lib/agents/writer').WriterOutput[] = Array.isArray(handoffIn)
          ? (handoffIn as import('@/lib/agents/writer').WriterOutput[])
          : handoffIn != null ? [handoffIn as import('@/lib/agents/writer').WriterOutput] : []

        const severity = resolveCriticalSeverity({
          runConfigSeverity: typeof meta['run_config_severity'] === 'number'
            ? (meta['run_config_severity'] as number) : null,
          projectSeverity: typeof meta['project_severity'] === 'number'
            ? (meta['project_severity'] as number) : null,
          preset:       (meta['preset'] as string | undefined) ?? null,
          domainProfile: asProfileId(meta['domain_profile']),
        })

        const result = await new CriticalReviewer(contextualLlm).review(
          writerOutputs, severity, node.run_id, signal,
        )
        return {
          handoffOut: result,
          costUsd:   0,
          tokensIn:  result.meta.tokens_input,
          tokensOut: result.meta.tokens_output,
          llm_model: contextualLlm.lastModel ?? undefined,
        }
      }

      default:
        // Should never reach here: whitelist check above catches unknown types first.
        throw new Error(
          `[agentRunner] Unhandled agent_type: "${node.agent_type}". `
          + `Allowed: ${[...ALLOWED_AGENT_TYPES].join(', ')}`,
        )
    }
  }
}

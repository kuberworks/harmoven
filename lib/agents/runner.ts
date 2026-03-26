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

// ─── ContextualLLMClient ──────────────────────────────────────────────────────

/**
 * Wraps an ILLMClient to inject per-node selection context into every call.
 * This enables multi-criteria routing (selectLlm) in DirectLLMClient for nodes
 * that carry confidentiality/jurisdiction/budget constraints in their metadata.
 * Agents never need to be aware of this — they just call llm.chat() as normal.
 */
class ContextualLLMClient implements ILLMClient {
  constructor(
    private readonly inner: ILLMClient,
    private readonly ctx: ChatOptions['selectionContext'],
  ) {}

  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    return this.inner.chat(messages, { ...options, selectionContext: this.ctx })
  }

  stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
  ): Promise<ChatResult> {
    return this.inner.stream(messages, { ...options, selectionContext: this.ctx }, onChunk)
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
  return async (node: NodeRow, handoffIn: unknown, signal: AbortSignal): Promise<AgentOutput> => {
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
        const input = typeof handoffIn === 'string'
          ? handoffIn
          : ((handoffIn as Record<string, unknown> | null)?.['input'] as string | undefined) ?? ''

        const result = await new IntentClassifier(contextualLlm).classify(input, signal)
        return { handoffOut: result, costUsd: 0, tokensIn: 0, tokensOut: 0 }
      }

      // ── PLANNER ─────────────────────────────────────────────────────────────
      case 'PLANNER': {
        const classifierResult = handoffIn as ClassifierResult
        // task_input may be stashed in metadata (e.g. when the run was created directly
        // without a CLASSIFIER node). Fall back to the classifier's input_summary.
        const taskInput = (meta['task_input'] as string | undefined)
          ?? classifierResult?.input_summary
          ?? ''

        const result = await new Planner(contextualLlm).plan(
          taskInput, classifierResult, node.run_id, signal,
        )
        return { handoffOut: result, costUsd: 0, tokensIn: 0, tokensOut: 0 }
      }

      // ── WRITER ──────────────────────────────────────────────────────────────
      case 'WRITER': {
        const nodeInput: WriterNodeInput = {
          node_id:              node.node_id,
          description:          (meta['description'] as string | undefined) ?? '',
          complexity:           (meta['complexity'] as WriterNodeInput['complexity'] | undefined) ?? 'medium',
          expected_output_type: (meta['expected_output_type'] as string | undefined) ?? 'document',
          // handoff_in from the executor holds the merged upstream outputs keyed by "output:nX"
          inputs: (typeof node.handoff_in === 'object' && node.handoff_in !== null
            ? node.handoff_in
            : {}) as Record<string, unknown>,
          domain_profile: asProfileId(meta['domain_profile']),
          run_id:         node.run_id,
        }

        const result = await new Writer(contextualLlm).execute(nodeInput, signal)
        return {
          handoffOut: result,
          costUsd:   0,
          tokensIn:  result.execution_meta.tokens_input,
          tokensOut: result.execution_meta.tokens_output,
        }
      }

      // ── REVIEWER ────────────────────────────────────────────────────────────
      case 'REVIEWER': {
        // handoffIn from the executor is either a single WriterOutput or an array
        const writerOutputs: WriterOutput[] = Array.isArray(handoffIn)
          ? (handoffIn as WriterOutput[])
          : handoffIn != null ? [handoffIn as WriterOutput] : []
        const profile = asProfileId(meta['domain_profile'])

        const result = await new Reviewer(contextualLlm).review(
          writerOutputs, profile, node.run_id, signal,
        )
        return {
          handoffOut: result,
          costUsd:   0,
          tokensIn:  result.meta.tokens_input,
          tokensOut: result.meta.tokens_output,
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

        return { handoffOut: result, costUsd: 0, tokensIn: 0, tokensOut: 0 }
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
        return { handoffOut: { repaired: true, worktree, subpath }, costUsd: 0, tokensIn: 0, tokensOut: 0 }
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

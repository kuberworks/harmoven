// lib/agents/runner.ts
// Production AgentRunnerFn — dispatches to the correct agent class based on node.agent_type.
// Wired into createExecutionEngine() as the default agentRunner.
//
// Node metadata contract (written when nodes are persisted from Planner output):
//   WRITER:           { description, complexity, expected_output_type, domain_profile, task_type? }
//   REVIEWER:         { domain_profile, output_language? }
//   PLANNER:          { task_input? }
//   CLASSIFIER:       handoffIn = string | { input: string }
//   SMOKE_TEST:       { worktree, routes?, timeout_s? }
//   REPAIR:           { worktree, subpath } — used standalone (smoke-test integrates repair internally)
//   CRITICAL_REVIEW:  { domain_profile, run_config_severity?, project_severity?, preset? }
//   PYTHON_EXECUTOR:  { timeout_ms?, packages? } — handoffIn.output.content (WriterOutput) is the code
//                      packages: explicit PyPI names (only when import name ≠ package name).
//                      If absent, third-party imports are auto-detected from the code's AST.
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
import { Reviewer, type ReviewerTaskContext } from '@/lib/agents/reviewer'
import type { WriterOutput } from '@/lib/agents/writer'
import { runSmokeTest } from '@/lib/agents/scaffolding/smoke-test.agent'
import { repairForSubpath } from '@/lib/agents/scaffolding/repair.agent'
import { CriticalReviewer } from '@/lib/agents/critical-reviewer'
import { resolveCriticalSeverity } from '@/lib/agents/reviewer/critical-reviewer.types'
import { PromptSummaryCaptureClient } from '@/lib/agents/prompt-summary'
import { executePython } from '@/lib/agents/python-executor'
import { convertToFile, type OutputFileFormat } from '@/lib/execution/converters/text-to-file'
import { validateArtifact } from '@/lib/execution/converters/validate'
import { parseRunConfig } from '@/lib/execution/run-config'
import { WEB_SEARCH_TOOL } from '@/lib/agents/tools/registry'
import { makeWebSearchExecutor, type WebSearchDb } from '@/lib/agents/tools/web-search'
import { ToolInjectionLLMClient } from '@/lib/llm/tool-injection-client'
import { DirectImageClient, createImageClient } from '@/lib/llm/image-client'
import { selectImageModel } from '@/lib/llm/selector'
import { buildFilename } from '@/lib/execution/converters/sanitize'
import { db } from '@/lib/db/client'
import { projectEventBus } from '@/lib/events/project-event-bus.factory'

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
  'SMOKE_TEST', 'REPAIR', 'CRITICAL_REVIEW', 'PYTHON_EXECUTOR', 'IMAGE_GEN',
])

function asProfileId(v: unknown): ProfileId {
  if (typeof v === 'string' && VALID_PROFILES.has(v)) return v as ProfileId
  return 'generic'
}

/**
 * C4 — Auto-promote orphan artifacts to 'primary' when a run completes.
 * If a run finishes COMPLETED and there are artifacts still in 'pending_review'
 * state (i.e. no REVIEWER node ran to set them to 'primary'), promote them
 * automatically. Also sets Run.primary_artifact_id to the first promoted artifact.
 *
 * Called by the executor right after transitioning a run to COMPLETED.
 * Spec: multi-format-artifact-output.feature.md Part 1 §1.8a (C4 rule)
 */
export async function promoteOrphanArtifacts(runId: string): Promise<void> {
  const updated = await db.runArtifact.updateMany({
    where: { run_id: runId, artifact_role: 'pending_review' },
    data:  { artifact_role: 'primary' },
  })
  if (updated.count > 0) {
    // Set primary_artifact_id to the first promoted artifact
    const first = await db.runArtifact.findFirst({
      where:   { run_id: runId, artifact_role: 'primary' },
      orderBy: { created_at: 'asc' },
      select:  { id: true },
    })
    if (first) {
      await db.run.update({
        where: { id: runId },
        data:  { primary_artifact_id: first.id },
      })
    }
  }
}

/**
 * C3-REVIEWER-APPROVE — Promote all pending_review artifacts for a run to 'primary'.
 * Sets Run.primary_artifact_id to the oldest promoted artifact.
 *
 * Called by the executor after a REVIEWER node completes with verdict APPROVE.
 * Spec: multi-format-artifact-output.feature.md Phase 5 §3b
 */
export async function promoteArtifactsAfterApprove(runId: string): Promise<void> {
  const updated = await db.runArtifact.updateMany({
    where: { run_id: runId, artifact_role: 'pending_review' },
    data:  { artifact_role: 'primary' },
  })
  if (updated.count > 0) {
    const first = await db.runArtifact.findFirst({
      where:   { run_id: runId, artifact_role: 'primary' },
      orderBy: { created_at: 'asc' },
      select:  { id: true },
    })
    if (first) {
      await db.run.update({
        where: { id: runId },
        data:  { primary_artifact_id: first.id },
      })
    }
  }
}

/**
 * C3-REVIEWER-REJECT — Discard all pending_review artifacts for a run.
 *
 * Called by the executor after a REVIEWER node completes with verdict REQUEST_REVISION.
 * Spec: multi-format-artifact-output.feature.md Phase 5 §3c
 */
export async function discardPendingArtifacts(runId: string): Promise<void> {
  await db.runArtifact.updateMany({
    where: { run_id: runId, artifact_role: 'pending_review' },
    data:  { artifact_role: 'discarded' },
  })
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
    /** Fired once when the model string is first known (first LLM call response). */
    private readonly onModelResolved?: (model: string) => void,
  ) {}

  private _trackModel(model: string | undefined) {
    if (!model) return
    const isFirst = this.lastModel === null
    this.lastModel = model
    if (isFirst) this.onModelResolved?.(model)
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const result = await this.inner.chat(messages, { ...options, selectionContext: this.ctx })
    this.totalCostUsd   += result.costUsd
    this.totalTokensIn  += result.tokensIn
    this.totalTokensOut += result.tokensOut
    this._trackModel(result.model)
    return result
  }

  async stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
    onModelResolved?: (model: string) => void,
  ): Promise<ChatResult> {
    const result = await this.inner.stream(
      messages,
      { ...options, selectionContext: this.ctx },
      onChunk,
      // Fire onModelResolved as soon as the inner client selects the model
      // (before the stream starts) so the UI shows the model while RUNNING.
      (model) => this._trackModel(model),
    )
    this.totalCostUsd   += result.costUsd
    this.totalTokensIn  += result.tokensIn
    this.totalTokensOut += result.tokensOut
    // _trackModel may already have been called by onModelResolved above;
    // call again to ensure lastModel is set even if inner skipped the callback.
    this._trackModel(result.model)
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
  return async (node: NodeRow, handoffIn: unknown, signal: AbortSignal, onChunk?: (chunk: string) => void, onModelResolved?: (model: string) => void): Promise<AgentOutput> => {
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
    const contextualLlm = new ContextualLLMClient(llm, selectionContext, onModelResolved)

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

        // Am.64-followup: for runs spawned via SPAWN_FOLLOWUP, the executor stores a
        // truncated summary of the parent's WRITER/PYTHON_EXECUTOR outputs in
        // meta.prior_run_context.  Pass it to the Planner so it knows what already
        // exists and can build the child DAG without re-generating prior artefacts.
        const priorContext = typeof meta['prior_run_context'] === 'string'
          ? meta['prior_run_context']
          : undefined

        const result = await new Planner(captureClient).plan(
          taskInput, classifierResult, node.run_id, signal, priorContext,
        )
        return { handoffOut: result, costUsd: contextualLlm.totalCostUsd, tokensIn: contextualLlm.totalTokensIn, tokensOut: contextualLlm.totalTokensOut, llm_model: contextualLlm.lastModel ?? undefined }
      }

      // ── WRITER ──────────────────────────────────────────────────────────────
      case 'WRITER': {
        const outputFileFormat = typeof meta['output_file_format'] === 'string'
          ? (meta['output_file_format'] as OutputFileFormat)
          : undefined

        // Fetch run_config + project_id once — used for web search injection and SSE
        const runData = await db.run.findUnique({
          where:  { id: node.run_id },
          select: { run_config: true, project_id: true },
        })
        const runConfig  = parseRunConfig(runData?.run_config)
        const projectId  = runData?.project_id ?? ''

        // Conditionally inject web search tools when run_config.enable_web_search is set
        let tools:        import('@/lib/llm/interface').ChatOptions['tools']        = undefined
        let toolExecutor: import('@/lib/llm/interface').ChatOptions['toolExecutor'] = undefined

        if (runConfig.enable_web_search === true) {
          tools = [WEB_SEARCH_TOOL]
          toolExecutor = makeWebSearchExecutor(
            runConfig,
            db as unknown as WebSearchDb,
            { project_id: projectId, run_id: node.run_id, node_id: node.node_id ?? node.id },
            (query, resultCount, iteration, isError) => {
              void projectEventBus.emit({
                project_id: projectId,
                run_id:     node.run_id,
                event: {
                  type:         'tool_call_progress',
                  node_id:      node.node_id ?? node.id,
                  tool_name:    'web_search',
                  iteration,
                  query,
                  result_count: resultCount,
                  is_error:     isError,
                },
                emitted_at: new Date(),
              }).catch(() => {}) // non-blocking
            },
          )
        }

        // Wrap with ToolInjectionLLMClient when tools are available; otherwise use raw captureClient
        const writerClient = (tools && toolExecutor)
          ? new ToolInjectionLLMClient(captureClient, tools, toolExecutor)
          : captureClient

        // Pre-inject web search results for providers that don't reliably call tools
        // (e.g. MiniMax, custom OpenAI-compat models). For Anthropic, anthropicNativeWebSearch
        // handles search natively — the pre-injected context is redundant but harmless.
        // Non-fatal: if the pre-search fails we simply proceed without it.
        let preSearchContext: string | undefined
        if (toolExecutor) {
          const nodeDescription = (meta['description'] as string | undefined) ?? ''
          if (nodeDescription.trim()) {
            try {
              const preResults = await toolExecutor(
                [{ id: 'pre-search-0', name: 'web_search', input: { query: nodeDescription, max_results: 5 } }],
                signal,
              )
              const r = preResults[0]
              if (r && !r.is_error && r.content) {
                preSearchContext = r.content
              }
            } catch {
              // non-fatal — proceed without pre-search context
            }
          }
        }

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
          domain_profile:      asProfileId(meta['domain_profile']),
          run_id:              node.run_id,
          output_file_format:  outputFileFormat,
          enable_web_search:   runConfig.enable_web_search === true,
          pre_search_context:  preSearchContext,
        }

        const result = await new Writer(writerClient).execute(nodeInput, signal, onChunk)

        // Persist tool_calls_trace in Node.metadata for observability (spec §4.4)
        if (result.execution_meta?.tool_calls_trace?.length) {
          const existingMeta = (typeof node.metadata === 'object' && node.metadata !== null
            ? node.metadata
            : {}) as Record<string, unknown>
          const updatedMeta = {
            ...existingMeta,
            tool_calls_trace: result.execution_meta.tool_calls_trace,
          }
          // JSON round-trip ensures Prisma's InputJsonValue constraint is satisfied
          await db.node.update({
            where: { id: node.id },
            data:  { metadata: JSON.parse(JSON.stringify(updatedMeta)) },
          })
        }

        // NEW: convert raw LLM output into a downloadable file when output_file_format
        // is explicitly set on the node (spec §1.6).
        if (outputFileFormat) {
          const slug = (meta['description'] as string | undefined) ?? node.node_id
          const { bytes, filename, mimeType } = await convertToFile(
            result.output.content,
            outputFileFormat,
            slug,
          )
          validateArtifact(bytes, outputFileFormat)
          const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
          const artifact = await db.runArtifact.create({
            data: {
              run_id:        node.run_id,
              node_id:       node.node_id,
              filename,
              mime_type:     mimeType,
              artifact_role: 'pending_review', // promoted by Phase 5 reviewer, or C4 on COMPLETED
              data:          bytes as unknown as Uint8Array<ArrayBuffer>,
              size_bytes:    bytes.byteLength,
              expires_at:    expiresAt,
            },
          })
          // SSE so the UI download section updates without polling
          if (projectId) {
            void projectEventBus.emit({
              project_id: projectId,
              run_id:     node.run_id,
              event: {
                type:           'artifact_ready',
                artifact_id:    artifact.id,
                filename,
                mime_type:      mimeType,
                node_id:        node.node_id,
                artifact_role:  artifact.artifact_role,
              },
              emitted_at: new Date(),
            })
            void projectEventBus.emit({
              project_id: projectId,
              run_id:     node.run_id,
              event: {
                type:           'artifacts_ready',
                node_id:        node.node_id,
                artifact_count: 1,
                filenames:      [filename],
              },
              emitted_at: new Date(),
            })
          }
          console.log(`[agentRunner] WRITER artifact created: ${filename} (id=${artifact.id}, ${bytes.byteLength} bytes)`)
        }

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
        // handoffIn from the executor is either a single WriterOutput or an array.
        // Filter to keep only real WriterOutput shapes (must have output.content: string).
        // Non-WriterOutput nodes upstream (PYTHON_EXECUTOR, CLASSIFIER, etc.) are silently
        // excluded — they are not subject to Reviewer quality assessment.
        const raw: unknown[] = Array.isArray(handoffIn)
          ? (handoffIn as unknown[])
          : handoffIn != null ? [handoffIn] : []
        let writerOutputs: WriterOutput[] = raw.filter(
          (h): h is WriterOutput =>
            typeof h === 'object' && h !== null &&
            typeof (h as Record<string, unknown>)['output'] === 'object' &&
            (h as Record<string, unknown>)['output'] !== null &&
            typeof ((h as Record<string, unknown>)['output'] as Record<string, unknown>)['content'] === 'string',
        )

        // ── PYTHON_EXECUTOR upstream synthesis ──────────────────────────────
        // When the only upstream nodes are PYTHON_EXECUTOR nodes (scaffold pipeline:
        //   WRITER(python_code) → PYTHON_EXECUTOR → REVIEWER),
        // writerOutputs will be empty because PYTHON_EXECUTOR's handoff_out has `stdout`
        // not `output.content`. Synthesize a WriterOutput-compatible object so the
        // Reviewer LLM receives meaningful content instead of an empty array.
        if (writerOutputs.length === 0) {
          const pyHandoffs = raw.filter(
            (h): h is Record<string, unknown> =>
              typeof h === 'object' && h !== null &&
              typeof (h as Record<string, unknown>)['exit_code'] === 'number' &&
              'artifact_count' in (h as Record<string, unknown>),
          )
          if (pyHandoffs.length > 0) {
            // Fetch artifact filenames from DB so reviewer sees the real file manifest.
            const artifacts = await db.runArtifact.findMany({
              where:  { run_id: node.run_id, artifact_role: { not: 'discarded' } },
              select: { filename: true, mime_type: true, node_id: true },
              orderBy: { created_at: 'asc' },
            })

            const fileManifest = artifacts.length > 0
              ? artifacts.map(a => `- ${a.filename}`).join('\n')
              : '(no files were collected — check the node output for details)'

            const pyHandoff   = pyHandoffs[0]!
            const stdout      = typeof pyHandoff['stdout'] === 'string' ? pyHandoff['stdout'] : ''
            const artifactCount = typeof pyHandoff['artifact_count'] === 'number'
              ? (pyHandoff['artifact_count'] as number)
              : artifacts.length

            const synthesized: WriterOutput = {
              handoff_version: '1.0',
              source_agent:    'WRITER',
              source_node_id:  'python_executor',
              target_agent:    'REVIEWER',
              run_id:          node.run_id,
              output: {
                type:    'python_files',
                summary: `Project scaffold — ${artifactCount} file(s) generated`,
                content: [
                  `## Generated files (${artifactCount} total)\n${fileManifest}`,
                  stdout.trim() ? `\n## Script output\n\`\`\`\n${stdout.slice(0, 3000)}\`\`\`` : '',
                ].join('\n').trim(),
                confidence: 80,
                confidence_rationale: 'Files were generated by PYTHON_EXECUTOR',
              },
              assumptions_made: [],
              execution_meta: {
                llm_used:       'python_executor',
                tokens_input:   0,
                tokens_output:  0,
                duration_seconds: 0,
                retries:        0,
              },
              lateral_delegation_request: null,
            }
            writerOutputs = [synthesized]
          }
        }

        const profile = asProfileId(meta['domain_profile'])
        const outputLanguage = typeof meta['output_language'] === 'string'
          ? (meta['output_language'] as string)
          : undefined

        // Build task context: look up the description fields from every node's metadata.
        // The Planner writes `description` into each node's metadata — passing it to the
        // reviewer lets the LLM understand each writer's assigned scope (crucial when
        // writers are building complementary parts of the same artefact, e.g. worksheets).
        const runNodes = await db.node.findMany({
          where: { run_id: node.run_id },
          select: { node_id: true, metadata: true },
        })
        const taskContext: ReviewerTaskContext = {
          writerDescriptions: Object.fromEntries(
            runNodes
              .filter(n => n.metadata && typeof (n.metadata as Record<string, unknown>)['description'] === 'string')
              .map(n => [n.node_id, (n.metadata as Record<string, unknown>)['description'] as string]),
          ),
          reviewerDescription: typeof meta['description'] === 'string'
            ? (meta['description'] as string)
            : undefined,
        }

        const result = await new Reviewer(captureClient).review(
          writerOutputs, profile, node.run_id, signal, outputLanguage, taskContext,
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

      // ── PYTHON_EXECUTOR ─────────────────────────────────────────────────────
      // Runs Python code in a Pyodide (WebAssembly) sandbox.
      // handoffIn sources (handled in priority order, or array of these):
      //   1. { code: string }   — explicit code field
      //   2. WriterOutput       — uses output.content as the Python source
      //   3. string             — treated directly as code
      // When multiple upstream nodes feed in (array), each code block is extracted
      // and concatenated with a comment separator — allowing several WRITER nodes
      // to each produce a section of code that runs as a single combined script.
      // metadata: { timeout_ms? } — max execution time in ms (default 30 000, max 120 000)
      case 'PYTHON_EXECUTOR': {
        // Normalise handoffIn to an array so single and multi-input are handled uniformly.
        const inputs: unknown[] = Array.isArray(handoffIn)
          ? (handoffIn as unknown[])
          : handoffIn != null ? [handoffIn] : []

        function extractCode(item: unknown): string | null {
          if (typeof item === 'string') return item
          const r = item as Record<string, unknown>
          if (typeof r?.['code'] === 'string') return r['code'] as string
          const out = r?.['output'] as Record<string, unknown> | undefined
          if (typeof out?.['content'] === 'string') return out['content'] as string
          return null
        }

        const codeBlocks = inputs.map(extractCode).filter((c): c is string => c !== null)
        if (codeBlocks.length === 0) {
          throw new Error('[agentRunner] PYTHON_EXECUTOR: no code found in handoffIn (expected .code or .output.content)')
        }

        // Combine multiple code blocks with section separators so they run as one script.
        // Each block gets a comment header so Python tracebacks remain readable.
        const code = codeBlocks.length === 1
          ? codeBlocks[0]!
          : codeBlocks.map((block, i) => `# ── Section ${i + 1} ──\n${block}`).join('\n\n')

        const timeoutMs = typeof meta['timeout_ms'] === 'number'
          ? (meta['timeout_ms'] as number)
          : undefined

        const packages = Array.isArray(meta['packages'])
          ? (meta['packages'] as unknown[]).filter((p): p is string => typeof p === 'string')
          : undefined

        const result = await executePython({ code, timeout_ms: timeoutMs, packages }, signal)

        // Persist generated files as RunArtifact rows — done before the exit_code
        // check so partial artifacts (files saved before a crash) are still accessible.
        // C3: PYTHON_EXECUTOR produces supplementary artifacts (spec §1.8a).
        if (result.files.length > 0) {
          const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
          await db.runArtifact.createMany({
            data: result.files.map(f => ({
              run_id:        node.run_id,
              node_id:       node.node_id,
              filename:      f.name,
              mime_type:     f.mime,
              size_bytes:    f.sizeBytes,
              data:          Buffer.from(f.buffer),
              artifact_role: 'supplementary', // C3 — PYTHON_EXECUTOR artifacts are supplementary
              expires_at:    expiresAt,
            })),
          })

          // Emit SSE artifacts_ready event so the UI can update without polling
          const runForProject = await db.run.findUnique({ where: { id: node.run_id }, select: { project_id: true } })
          if (runForProject) {
            void projectEventBus.emit({
              project_id: runForProject.project_id,
              run_id:     node.run_id,
              event: {
                type:           'artifacts_ready',
                node_id:        node.node_id,
                artifact_count: result.files.length,
                filenames:      result.files.map(f => f.name),
              },
              emitted_at: new Date(),
            })
          }
        }

        // Python runtime error — throw so the executor marks the node FAILED,
        // blocks downstream nodes, and surfaces the error in the run detail UI.
        if (result.exit_code === 1) {
          const pythonError = result.error ?? result.stderr.slice(0, 500) ?? 'Python execution failed'
          throw new Error(`[PYTHON_EXECUTOR] ${pythonError}`)
        }

        return {
          handoffOut: {
            stdout:         result.stdout,
            stderr:         result.stderr,
            exit_code:      result.exit_code,
            duration_ms:    result.duration_ms,
            truncated:      result.truncated,
            error:          result.error,
            artifact_count: result.files.length,
            ...(result.skipped_files.length > 0 && { skipped_files: result.skipped_files }),
          },
          costUsd:   0,
          tokensIn:  0,
          tokensOut: 0,
          llm_model: undefined,
        }
      }

      // ── IMAGE_GEN ─────────────────────────────────────────────────────────
      case 'IMAGE_GEN': {
        // Extract prompt from handoffIn (string or structured {prompt} / {output.content})
        function extractImagePrompt(hin: unknown): string | null {
          if (typeof hin === 'string' && hin.trim()) return hin.trim()
          const r = hin as Record<string, unknown> | null
          if (!r) return null
          if (typeof r['prompt'] === 'string') return r['prompt'] as string
          const out = r['output'] as Record<string, unknown> | undefined
          if (typeof out?.['content'] === 'string') return out['content'] as string
          return null
        }

        const prompt = extractImagePrompt(handoffIn)
        if (!prompt) {
          throw new Error('[IMAGE_GEN] No prompt found in handoffIn')
        }

        // Build selection context from node metadata (confidentiality, jurisdiction)
        const imageSelContext = {
          confidentiality: (meta['confidentiality'] as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined),
          jurisdictionTags: Array.isArray(meta['jurisdiction_tags']) ? (meta['jurisdiction_tags'] as string[]) : [],
        }

        let imageProfile: Awaited<ReturnType<typeof selectImageModel>>
        try {
          imageProfile = await selectImageModel(imageSelContext)
        } catch {
          throw new Error('No image generation provider is configured.')
        }

        const imageClient = createImageClient(imageProfile)
        const result = await imageClient.generateImage(prompt, {
          model:  imageProfile.model_string,
          width:  typeof meta['width']  === 'number' ? (meta['width']  as number) : 1024,
          height: typeof meta['height'] === 'number' ? (meta['height'] as number) : 1024,
          signal,
        })

        const ext       = result.mimeType.split('/')[1] ?? 'png'
        const filename  = buildFilename('image', ext)
        const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)

        const artifact = await db.runArtifact.create({
          data: {
            run_id:        node.run_id,
            node_id:       node.node_id,
            filename,
            mime_type:     result.mimeType,
            artifact_role: 'primary',
            data:          result.bytes as unknown as Uint8Array<ArrayBuffer>,
            size_bytes:    result.bytes.byteLength,
            expires_at:    expiresAt,
          },
        })

        // Set primary_artifact_id on the run
        await db.run.update({
          where: { id: node.run_id },
          data:  { primary_artifact_id: artifact.id },
        })

        console.log(`[agentRunner] IMAGE_GEN artifact created: ${filename} (id=${artifact.id}, ${result.bytes.byteLength} bytes)`)

        // Emit SSE events
        const imageRunData = await db.run.findUnique({ where: { id: node.run_id }, select: { project_id: true } })
        if (imageRunData) {
          void projectEventBus.emit({
            project_id: imageRunData.project_id,
            run_id:     node.run_id,
            event: {
              type:          'artifact_ready',
              artifact_id:   artifact.id,
              filename,
              mime_type:     result.mimeType,
              node_id:       node.node_id,
              artifact_role: 'primary',
            },
            emitted_at: new Date(),
          })
          void projectEventBus.emit({
            project_id: imageRunData.project_id,
            run_id:     node.run_id,
            event: {
              type:           'artifacts_ready',
              node_id:        node.node_id,
              artifact_count: 1,
              filenames:      [filename],
            },
            emitted_at: new Date(),
          })
        }

        return {
          handoffOut: { artifact_id: artifact.id, mime_type: result.mimeType, filename },
          costUsd:    result.costUsd,
          tokensIn:   0,
          tokensOut:  0,
          llm_model:  result.model,
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
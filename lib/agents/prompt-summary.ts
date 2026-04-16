// lib/agents/prompt-summary.ts
// PromptSummaryCaptureClient — lightweight wrapper that snapshots execution context
// without storing the full prompts (Amendment 86).
//
// After each agent completes, captures:
// - Domain profile + complexity at execution time
// - Upstream node references (for audit trail)
// - Output type expectations
// - Approximate token usage
//
// Does NOT persist full prompts — see docs/prompt-storage.md for rationale.
// Enables transparency + compliance without GDPR/storage burden.

import { createHash } from 'node:crypto'
import type { ILLMClient, ChatMessage, ChatOptions, ChatResult } from '@/lib/llm/interface'
import { db } from '@/lib/db/client'

export interface ExecutionContextSnapshot {
  profile_detected_at: string  // agent name that detected this profile
  complexity?: 'low' | 'medium' | 'high'
  expected_output_type?: string  // code | document | data | media
  task_input_truncated?: string  // First 200 chars only
  upstream_nodes: Array<{
    node_id: string
    agent_type: string
    content_hash: string  // SHA256 of handoff_out
  }>
}

export class PromptSummaryCaptureClient implements ILLMClient {
  private upstreamNodes: Array<{ node_id: string; agent_type: string; content: unknown }> = []
  private complexity?: 'low' | 'medium' | 'high'
  private expectedOutputType?: string
  private profileDetectedAt: string = ''
  private taskInputTruncated: string = ''

  constructor(
    private readonly inner: ILLMClient,
    private readonly runId: string,
    private readonly nodeId: string,
    private readonly agentType: string,
    private readonly domainProfile: string,
  ) {}

  /**
   * Set upstream context before calling chat() — used by agent runners
   * to populate the execution snapshot.
   */
  setUpstreamNodes(nodes: Array<{ node_id: string; agent_type: string; handoff_out: unknown }>): void {
    this.upstreamNodes = nodes.map(n => ({
      node_id: n.node_id,
      agent_type: n.agent_type,
      content: n.handoff_out,
    }))
  }

  setComplexity(complexity: 'low' | 'medium' | 'high'): void {
    this.complexity = complexity
  }

  setExpectedOutputType(type: string): void {
    this.expectedOutputType = type
  }

  setProfileDetectedAt(agent: string): void {
    this.profileDetectedAt = agent
  }

  setTaskInputTruncated(input: string | object): void {
    const str = typeof input === 'string' ? input : JSON.stringify(input)
    this.taskInputTruncated = str.slice(0, 200)
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    // Delegate real call to underlying LLM
    const result = await this.inner.chat(messages, options ?? { model: 'balanced' })

    // After successful completion, snapshot the context
    await this.persistPromptSummary(messages)

    return result
  }

  async stream(
    messages: ChatMessage[],
    options: ChatOptions,
    onChunk: (chunk: string) => void,
    onModelResolved?: (model: string) => void,
  ): Promise<ChatResult> {
    const result = await this.inner.stream(messages, options, onChunk, onModelResolved)

    // Snapshot after streaming completes
    await this.persistPromptSummary(messages)

    return result
  }

  /**
   * Persist lightweight prompt summary (context only, not the full prompt).
   */
  private async persistPromptSummary(messages: ChatMessage[]): Promise<void> {
    try {
      // Build execution context snapshot
      const executionContext: ExecutionContextSnapshot = {
        profile_detected_at: this.profileDetectedAt || this.agentType,
        complexity: this.complexity,
        expected_output_type: this.expectedOutputType,
        task_input_truncated: this.taskInputTruncated || undefined,
        upstream_nodes: this.upstreamNodes.map(n => ({
          node_id: n.node_id,
          agent_type: n.agent_type,
          content_hash: this.hashContent(n.content),
        })),
      }

      // Hash upstream outputs to enable validation
      const upstreamHash = this.upstreamNodes.length > 0
        ? this.hashContent(
            JSON.stringify(this.upstreamNodes.map(n => n.content)),
          )
        : undefined

      // Estimate tokens (rough heuristic: ~4 chars = 1 token)
      const messagesText = messages.map(m => m.content).join('')
      const estimatedTokensIn = Math.ceil(messagesText.length / 4)

      // Upsert the summary record — a node may be retried/replayed, in which
      // case (run_id, node_id) already exists from the previous execution.
      await (db as any).promptSummary.upsert({
        where: { run_id_node_id: { run_id: this.runId, node_id: this.nodeId } },
        create: {
          run_id: this.runId,
          node_id: this.nodeId,
          agent_type: this.agentType,
          domain_profile: this.domainProfile,
          execution_context: executionContext,
          estimated_tokens_in: estimatedTokensIn,
          upstream_handoff_hash: upstreamHash,
          serialization_version: '1.0',
        },
        update: {
          agent_type: this.agentType,
          domain_profile: this.domainProfile,
          execution_context: executionContext,
          estimated_tokens_in: estimatedTokensIn,
          upstream_handoff_hash: upstreamHash,
          serialization_version: '1.0',
        },
      })
    } catch (err) {
      // Non-fatal — a failure to log should not break execution
      console.warn(`[PromptSummary] failed to persist context for node ${this.nodeId}:`, err)
    }
  }

  private hashContent(content: unknown): string {
    const str = typeof content === 'string'
      ? content
      : content === null || content === undefined
      ? ''
      : JSON.stringify(content)

    return createHash('sha256').update(str).digest('hex')
  }
}

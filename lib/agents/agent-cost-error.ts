// lib/agents/agent-cost-error.ts
// Error subclass that carries partial LLM cost information.
// Thrown by agent runner implementations when the LLM call succeeded (tokens
// were consumed) but post-processing failed (e.g. JSON parse, validation).
// The executor catch block reads these fields and persists cost to the DB
// so the run budget remains accurate even on failed nodes.

export class AgentCostError extends Error {
  constructor(
    message: string,
    public readonly costUsd: number,
    public readonly tokensIn: number,
    public readonly tokensOut: number,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'AgentCostError'
    if (cause instanceof Error) this.cause = cause
  }
}

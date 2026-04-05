// app/api/runs/[runId]/prompt-summaries/route.ts
// GET /api/runs/:runId/prompt-summaries
// Retrieve lightweight prompt execution context for all nodes in a completed run.
// Amendment 86 — Transparency without full prompt storage.
//
// Security:
// - Requires runs:read permission
// - Returns contextual metadata only (no actual prompts)
// - Safe for audit + compliance use cases

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params

  // ─── Auth ──────────────────────────────────────────────────────────────────
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ─── Run access ────────────────────────────────────────────────────────────
  const runLookup = await db.run.findUnique({
    where: { id: runId },
    select: { project_id: true, status: true },
  })
  if (!runLookup) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, runLookup.project_id)
    await assertRunAccess(runId, runLookup.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, runLookup.project_id)
  if (!perms.has('runs:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ─── Retrieve prompt summaries ─────────────────────────────────────────────
  const summaries = await (db as any).promptSummary.findMany({
    where: { run_id: runId },
    select: {
      id: true,
      node_id: true,
      agent_type: true,
      domain_profile: true,
      execution_context: true,
      estimated_tokens_in: true,
      estimated_tokens_out: true,
      upstream_handoff_hash: true,
      created_at: true,
    },
    orderBy: { created_at: 'asc' },
  })

  // ─── Build response with additional metadata ───────────────────────────────
  const nodeData = await Promise.all(
    summaries.map(async (summary: any) => {
      // Fetch the actual node for additional context (status, completion time)
      const node = await db.node.findFirst({
        where: { run_id: runId, node_id: summary.node_id },
        select: {
          status: true,
          started_at: true,
          completed_at: true,
          error: true,
          retries: true,
          tokens_in: true,
          tokens_out: true,
          cost_usd: true,
        },
      })

      return {
        node_id: summary.node_id,
        agent_type: summary.agent_type,
        domain_profile: summary.domain_profile,
        
        // Execution context snapshot
        execution_context: summary.execution_context,
        
        // Token estimates vs actual
        token_estimate: {
          tokens_in: summary.estimated_tokens_in,
          tokens_out: summary.estimated_tokens_out,
        },
        token_actual: node ? {
          tokens_in: node.tokens_in,
          tokens_out: node.tokens_out,
        } : null,
        
        // Audit trail
        upstream_handoff_hash: summary.upstream_handoff_hash,
        
        // Node status
        status: node?.status,
        error: node?.error,
        retries: node?.retries,
        started_at: node?.started_at?.toISOString() ?? null,
        completed_at: node?.completed_at?.toISOString() ?? null,
        cost_usd: node ? Number(node.cost_usd) : null,
        
        // Context metadata
        snapshot_created_at: summary.created_at.toISOString(),
      }
    }),
  )

  return NextResponse.json({
    run_id: runId,
    run_status: runLookup.status,
    prompt_summaries: nodeData,
    note: 'Prompt execution context captured per Amendment 86. Full prompts not stored for GDPR compliance.',
  })
}

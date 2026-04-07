// app/api/runs/[runId]/route.ts
// GET /api/runs/:runId  — Fetch a run with its nodes (session or API key auth).
// Spec: getRun (runs:read permission required).

import { NextRequest, NextResponse } from 'next/server'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertProjectAccess, assertRunAccess } from '@/lib/auth/ownership'
import { resolvePermissions, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'

type Params = { params: Promise<{ runId: string }> }

/** Extract a short plaintext summary from a completed node's handoff_out for run chaining pre-fill. */
function extractOutputSummary(handoffOut: unknown): string | null {
  if (!handoffOut || typeof handoffOut !== 'object') return null
  const h = handoffOut as Record<string, unknown>
  // Reviewer formatted_content takes priority
  if (typeof h['formatted_content'] === 'string' && h['formatted_content']) {
    return h['formatted_content'].slice(0, 2000)
  }
  const output = h['output'] as Record<string, unknown> | undefined
  if (!output) return null
  const summary = output['summary'] as string | undefined
  const content = (output['content'] ?? output['text']) as string | undefined
  if (summary) return summary.slice(0, 500)
  if (content) return content.slice(0, 2000)
  return null
}

export async function GET(req: NextRequest, { params }: Params) {
  const { runId } = await params

  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const runLookup = await db.run.findUnique({
    where:  { id: runId },
    select: { project_id: true },
  })
  if (!runLookup) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await assertProjectAccess(caller, runLookup.project_id)
    await assertRunAccess(runId, runLookup.project_id)
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (e instanceof ForbiddenError)    return NextResponse.json({ error: 'Forbidden'    }, { status: 403 })
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const perms = await resolvePermissions(caller, runLookup.project_id)
  if (!perms.has('runs:read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const hasCosts = perms.has('runs:read_costs')

  const [run, nodes, parentLinks, childLinks] = await Promise.all([
    db.run.findUnique({ where: { id: runId } }),
    db.node.findMany({ where: { run_id: runId }, orderBy: { node_id: 'asc' } }),
    db.runDependency.findMany({
      where: { child_run_id: runId },
      select: {
        parent_run: {
          select: { id: true, status: true, created_at: true, task_input: true },
        },
      },
    }),
    db.runDependency.findMany({
      where: { parent_run_id: runId },
      select: {
        child_run: {
          select: { id: true, status: true, created_at: true, task_input: true },
        },
      },
    }),
  ])
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Redact cost fields if caller lacks runs:read_costs
  const safeRun = hasCosts
    ? run
    : { ...run, cost_actual_usd: undefined, tokens_actual: undefined }

  const safeNodes = nodes.map(n =>
    hasCosts ? n : { ...n, cost_usd: undefined, tokens_input: undefined, tokens_output: undefined },
  )

  // Build output_summary from the last REVIEWER or WRITER COMPLETED node
  let outputSummary: string | null = null
  if (run.status === 'COMPLETED') {
    const reviewerNode = nodes.find(n => n.agent_type === 'REVIEWER' && n.status === 'COMPLETED')
    const writerNode   = [...nodes].reverse().find(n => n.agent_type === 'WRITER' && n.status === 'COMPLETED')
    outputSummary = extractOutputSummary(reviewerNode?.handoff_out) ?? extractOutputSummary(writerNode?.handoff_out)
  }

  const chain = {
    parents: parentLinks.map(l => ({
      id:         l.parent_run.id,
      status:     l.parent_run.status,
      created_at: l.parent_run.created_at.toISOString(),
      task_input: typeof l.parent_run.task_input === 'string'
        ? l.parent_run.task_input.slice(0, 100)
        : null,
    })),
    children: childLinks.map(l => ({
      id:         l.child_run.id,
      status:     l.child_run.status,
      created_at: l.child_run.created_at.toISOString(),
      task_input: typeof l.child_run.task_input === 'string'
        ? l.child_run.task_input.slice(0, 100)
        : null,
    })),
    output_summary: outputSummary,
  }

  return NextResponse.json({ run: safeRun, nodes: safeNodes, chain })
}

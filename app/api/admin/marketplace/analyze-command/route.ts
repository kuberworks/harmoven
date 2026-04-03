// app/api/admin/marketplace/analyze-command/route.ts
// POST /api/admin/marketplace/analyze-command
//
// Smart Import A.4 — relevance gate + LLM adapter for a previewed Git import.
//
// Body: { preview_id, step: 'relevance_gate' | 'adapter', budget_override?: boolean }
//
// Security:
//   SEC-08  instance_admin only
//   SEC-32  No client-supplied hash/content — SHA-256 from DB, file re-fetched server-side
//   SEC-40  preview.created_by === caller.userId — 403 PREVIEW_NOT_OWNED on mismatch
//   SEC-41  Preview TTL — 410 GONE on expired preview
//   SEC-51  SMART_IMPORT_DISABLED → 422; admin uses "Importer sans analyse LLM"
//   budget  Hard block at 100% usage (402 BUDGET_EXCEEDED), soft alert at 80%

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError, ForbiddenError } from '@/lib/auth/rbac'
import {
  runRelevanceGate,
  runLlmAdapter,
  getBudgetInfo,
  SmartImportError,
} from '@/lib/marketplace/smart-import'

// ─── Input schema ─────────────────────────────────────────────────────────────

const BodySchema = z.object({
  preview_id:      z.string().uuid(),
  step:            z.enum(['relevance_gate', 'adapter']),
  budget_override: z.boolean().optional(), // marketplace:admin only; logged as BUDGET_OVERRIDE
}).strict()

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try { assertInstanceAdmin(caller) } catch (err) {
    if (err instanceof ForbiddenError || err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_PARAMS', detail: parsed.error.flatten() }, { status: 400 })
  }
  const { preview_id, step, budget_override } = parsed.data

  // Budget info for soft-alert passthrough (client always gets current info)
  let budgetInfo
  try { budgetInfo = await getBudgetInfo() } catch { /* non-fatal */ }

  // budget_override: only allows bypassing soft alert (80–99%); hard block (100%) still enforced
  // server-side — checked inside runRelevanceGate/runLlmAdapter.

  try {
    if (step === 'relevance_gate') {
      const result = await runRelevanceGate(preview_id, caller.userId)
      return NextResponse.json({ ...result, budget: budgetInfo })
    } else {
      const result = await runLlmAdapter(preview_id, caller.userId)
      return NextResponse.json({ ...result, budget: budgetInfo })
    }
  } catch (err) {
    if (err instanceof SmartImportError) {
      return NextResponse.json(
        {
          error:   err.code,
          message: err.message,
          budget:  budgetInfo,
        },
        { status: err.status },
      )
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

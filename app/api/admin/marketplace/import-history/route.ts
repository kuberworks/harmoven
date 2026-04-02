// app/api/admin/marketplace/import-history/route.ts
// GET /api/admin/marketplace/import-history
// List marketplace import + upload audit events + Smart Import LLM cost tracking. Admin only.
//
// A.4.2 — Smart Import phantom runs are the cost source of truth.
// Non-LLM imports visible via AuditLog action_type filter.
// Monthly cost = SUM(cost_actual_usd) on phantom Runs (run_type='marketplace_import').

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError, ForbiddenError } from '@/lib/auth/rbac'

const QuerySchema = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  size:  z.coerce.number().int().min(1).max(100).default(20),
})

const IMPORT_ACTION_TYPES = [
  'marketplace_upload_approved',
  'claude_plugin_conversion_approved',
  'github_import_approved',
  'marketplace_smart_import_approved',
  'marketplace_smart_import_llm_call',
]

export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    assertInstanceAdmin(caller)
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    throw err
  }

  const params = Object.fromEntries(req.nextUrl.searchParams)
  const parsed = QuerySchema.safeParse(params)
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_PARAMS' }, { status: 400 })
  }
  const { page, size } = parsed.data

  const where = { action_type: { in: IMPORT_ACTION_TYPES } }

  const [total, entries] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip:    (page - 1) * size,
      take:    size,
    }),
  ])

  // Monthly LLM cost — sum cost_actual_usd on phantom runs for current UTC calendar month (A.4.2)
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const costAgg = await db.run.aggregate({
    _sum: { cost_actual_usd: true },
    where: {
      run_type:   'marketplace_import',
      created_at: { gte: monthStart },
      status:     { in: ['COMPLETED', 'FAILED'] },
    },
  })
  const monthlyCost = Number(costAgg._sum.cost_actual_usd ?? 0)

  // Monthly phantom run count
  const monthlyCallCount = await db.run.count({
    where: {
      run_type:   'marketplace_import',
      created_at: { gte: monthStart },
    },
  })

  // Budget setting
  const budgetSetting = await db.systemSetting.findUnique({
    where: { key: 'marketplace.smart_import.monthly_budget_usd' },
  })
  const monthlyBudget = budgetSetting?.value ? parseFloat(String(budgetSetting.value)) : null

  return NextResponse.json({
    data:                  entries,
    total,
    page,
    size,
    monthly_cost_usd:      monthlyCost,
    monthly_budget_usd:    monthlyBudget,
    monthly_llm_calls:     monthlyCallCount,
    budget_percent_used:   monthlyBudget
      ? Math.round((monthlyCost / monthlyBudget) * 100)
      : null,
  })
}

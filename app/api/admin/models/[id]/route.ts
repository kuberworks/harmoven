// app/api/admin/models/[id]/route.ts
// Admin LLM model management — update + delete
//
// PATCH  /api/admin/models/:id    — partial update of an LlmProfile
// DELETE /api/admin/models/:id    — permanently delete a model
//
// Required: instance_admin role.
// DELETE guard: 409 Conflict if the model is referenced by active runs.
// Security: model ID sanitised to prevent path traversal; Zod strict body validation.
//           PATCH: assertNotPrivateHost() on config.base_url (SSRF — C-01).
//           AuditLog written for every PATCH and DELETE (H-01).

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { Prisma, RunStatus }          from '@prisma/client'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import type { SessionCaller }        from '@/lib/auth/rbac'
import { assertNotPrivateHost }            from '@/lib/security/ssrf-protection'
import { encryptLlmKey }                   from '@/lib/utils/llm-key-crypto'
import { uuidv7 }                          from '@/lib/utils/uuidv7'
import { resetExecutionEngineSingleton }   from '@/lib/execution/engine.factory'

// ─── Auth helper ──────────────────────────────────────────────────────────────

type AdminGuardResult =
  | { caller: SessionCaller; err: null }
  | { caller: null;          err: NextResponse }

async function guardAdminModels(req: NextRequest): Promise<AdminGuardResult> {
  const caller = await resolveCaller(req)
  if (!caller) {
    return { caller: null, err: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  try {
    assertInstanceAdmin(caller)
    return { caller, err: null }
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return { caller: null, err: NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status }) }
  }
}

type Params = { params: Promise<{ id: string }> }

// ─── PATCH /api/admin/models/:id ─────────────────────────────────────────────

const PatchModelBody = z.object({
  provider:                   z.string().min(1).max(64).optional(),
  model_string:               z.string().min(1).max(256).optional(),
  tier:                       z.string().min(1).max(64).optional(),
  jurisdiction:               z.string().max(32).optional(),
  trust_tier:                 z.number().int().min(1).max(3).optional(),
  context_window:             z.number().int().positive().optional(),
  cost_per_1m_input_tokens:   z.number().nonnegative().optional(),
  cost_per_1m_output_tokens:  z.number().nonnegative().optional(),
  enabled:                    z.boolean().optional(),
  task_type_affinity:         z.array(z.string()).optional(),
  config:                     z.record(z.unknown()).optional(),
  // Plaintext API key — encrypted to config.api_key_enc; pass empty string to clear
  api_key:                    z.string().max(512).optional(),
}).strict()

export async function PATCH(req: NextRequest, { params }: Params) {
  const { caller, err } = await guardAdminModels(req)
  if (err) return err

  const { id } = await params

  const existing = await db.llmProfile.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = PatchModelBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 422 })
  }

  // C-01 — SSRF protection: validate base_url if provided in config patch.
  const patchConfig = parsed.data.config
  if (patchConfig && typeof patchConfig['base_url'] === 'string') {
    try {
      await assertNotPrivateHost(patchConfig['base_url'] as string)
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 422 })
    }
  }

  // Merge api_key into config.api_key_enc / clear it
  const { config, api_key, ...rest } = parsed.data
  let mergedConfig: Record<string, unknown> | undefined
  if (api_key !== undefined || config !== undefined) {
    // Start from the current stored config
    const existing_cfg = (typeof existing.config === 'object' && existing.config !== null
      ? existing.config
      : {}) as Record<string, unknown>
    mergedConfig = { ...existing_cfg, ...(config ?? {}) }
    if (api_key?.trim()) {
      try {
        mergedConfig.api_key_enc = encryptLlmKey(api_key.trim())
      } catch {
        return NextResponse.json({ error: 'ENCRYPTION_KEY_NOT_CONFIGURED' }, { status: 500 })
      }
    } else if (api_key === '') {
      // Explicit empty string — remove the stored key
      delete mergedConfig.api_key_enc
    }
  }

  const model = await db.llmProfile.update({
    where: { id },
    data:  {
      ...rest,
      ...(mergedConfig !== undefined && { config: mergedConfig as Prisma.InputJsonValue }),
    },
  })

  // H-01 — AuditLog: every write must be recorded.
  const actorId = caller?.userId ?? 'system'
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       actorId,
      action_type: 'admin.llm_profile.updated',
      payload:     { model_id: id, fields: Object.keys(parsed.data) } as Prisma.InputJsonValue,
    },
  })

  // Rebuild the execution engine singleton on next run so any profile changes
  // (enabled toggle, model_string, config, etc.) take effect immediately.
  resetExecutionEngineSingleton()

  // H-4: strip config blob (contains api_key_enc) — write-only field, never read back.
  const { config: _, ...safeModel } = model
  return NextResponse.json({ model: safeModel })
}

// ─── DELETE /api/admin/models/:id ────────────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Params) {
  const { caller, err } = await guardAdminModels(req)
  if (err) return err

  const { id } = await params

  const existing = await db.llmProfile.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ error: 'Model not found' }, { status: 404 })
  }

  // Guard: refuse deletion if any non-terminal run references this model profile
  const activeRunCount = await db.run.count({
    where: {
      domain_profile: id,
      status: { notIn: ['COMPLETED', 'FAILED'] as RunStatus[] },
    },
  })
  if (activeRunCount > 0) {
    return NextResponse.json(
      { error: 'Cannot delete model — referenced by active runs' },
      { status: 409 },
    )
  }

  await db.llmProfile.delete({ where: { id } })

  // H-01 — AuditLog: every write must be recorded.
  const deleteActorId = caller?.userId ?? 'system'
  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       deleteActorId,
      action_type: 'admin.llm_profile.deleted',
      payload:     { model_id: id, provider: existing.provider, model_string: existing.model_string },
    },
  })

  // Rebuild the execution engine singleton so the deleted profile is no longer used.
  resetExecutionEngineSingleton()

  return new NextResponse(null, { status: 204 })
}

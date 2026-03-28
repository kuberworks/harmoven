// app/api/admin/credentials/[credId]/route.ts
// Admin credential management — read + update + delete
//
// GET    /api/admin/credentials/:credId  — get a single credential (no value_enc)
// PATCH  /api/admin/credentials/:credId  — update name/host_pattern/etc., optionally rotate value
// DELETE /api/admin/credentials/:credId  — permanently delete a credential
//
// Required: instance_admin role.
// SECURITY: value_enc is NEVER returned. If `value` is provided on PATCH, it is
//   re-encrypted (key rotation) before storage.

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { createCipheriv, randomBytes } from 'node:crypto'
import type { CipherGCM }            from 'node:crypto'
import { deriveCredentialKey }        from '@/lib/utils/credential-crypto'
import { db }                        from '@/lib/db/client'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, UnauthorizedError } from '@/lib/auth/rbac'
import type { SessionCaller }        from '@/lib/auth/rbac'

// ─── Auth helper ──────────────────────────────────────────────────────────────

type AdminGuardResult =
  | { caller: SessionCaller; err: null }
  | { caller: null;          err: NextResponse }

async function guardAdminCreds(req: NextRequest): Promise<AdminGuardResult> {
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

// ─── Encryption ───────────────────────────────────────────────────────────────
// Key derivation: HKDF-SHA256 via lib/utils/credential-crypto.ts (CVE-HARM-001 fix).
// DO NOT revert to createHash('sha256').update(raw) — see security note in credential-crypto.ts.

function encryptValue(plaintext: string): string {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('[Credentials] ENCRYPTION_KEY is not set')
  const key    = deriveCredentialKey(raw)         // HKDF-SHA256 — not bare SHA-256
  const iv     = randomBytes(12)                  // 96-bit IV (GCM standard)
  const cipher = createCipheriv('aes-256-gcm', key, iv) as CipherGCM
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return `gcm:${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`
}

// ─── Safe credential select — value_enc excluded ──────────────────────────────

const CRED_SELECT = {
  id:           true,
  project_id:   true,
  name:         true,
  type:         true,
  inject_as:    true,
  inject_fmt:   true,
  host_pattern: true,
  path_pattern: true,
  tool_scope:   true,
  created_by:   true,
  created_at:   true,
  last_used_at: true,
  rotated_at:   true,
} as const

type Params = { params: Promise<{ credId: string }> }

// ─── GET /api/admin/credentials/:credId ───────────────────────────────────────

export async function GET(req: NextRequest, { params }: Params) {
  const { err } = await guardAdminCreds(req)
  if (err) return err

  const { credId } = await params

  const credential = await db.projectCredential.findUnique({
    where:  { id: credId },
    select: CRED_SELECT,
  })
  if (!credential) {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  }

  return NextResponse.json({ credential })
}

// ─── PATCH /api/admin/credentials/:credId ─────────────────────────────────────

const PatchCredentialBody = z.object({
  name:         z.string().min(1).max(128).optional(),
  value:        z.string().min(1).optional(), // triggers value_enc rotation + rotated_at update
  inject_as:    z.string().min(1).max(256).optional(),
  inject_fmt:   z.string().min(1).max(256).optional(),
  host_pattern: z.string().min(1).max(256).optional(),
  path_pattern: z.string().max(256).nullable().optional(),
  tool_scope:   z.array(z.string()).optional(),
}).strict()

export async function PATCH(req: NextRequest, { params }: Params) {
  const { caller, err } = await guardAdminCreds(req)
  if (err) return err

  const { credId } = await params

  const existing = await db.projectCredential.findUnique({
    where:  { id: credId },
    select: { id: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = PatchCredentialBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 422 })
  }

  const { value, ...rest } = parsed.data

  // If a new plaintext value is supplied, encrypt it and update rotated_at
  const encData = value
    ? { value_enc: encryptValue(value), rotated_at: new Date() }
    : {}

  const credential = await db.projectCredential.update({
    where:  { id: credId },
    data:   { ...rest, ...encData },
    select: CRED_SELECT,
  })

  await db.auditLog.create({
    data: {
      actor:       caller!.userId,
      action_type: 'credential_updated',
      payload: {
        credential_id:  credId,
        fields_updated: Object.keys(rest),
        value_rotated:  !!value,
      },
    },
  })

  return NextResponse.json({ credential })
}

// ─── DELETE /api/admin/credentials/:credId ────────────────────────────────────

export async function DELETE(req: NextRequest, { params }: Params) {
  const { err } = await guardAdminCreds(req)
  if (err) return err

  const { credId } = await params

  const existing = await db.projectCredential.findUnique({
    where:  { id: credId },
    select: { id: true },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  }

  await db.projectCredential.delete({ where: { id: credId } })

  return new NextResponse(null, { status: 204 })
}

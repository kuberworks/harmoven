// app/api/admin/credentials/route.ts
// Admin credential management — list + create
//
// GET  /api/admin/credentials           — list credentials (optionally filtered by ?project_id=)
// POST /api/admin/credentials           — create a new encrypted credential
//
// Required: instance_admin role.
// SECURITY: value_enc is NEVER returned. The plaintext `value` is encrypted
//   with AES-256-GCM using ENCRYPTION_KEY before storage.
//
// Format: gcm:<ivHex12B>:<ciphertextHex>:<tagHex16B>  (compatible with credential-scope.ts)

import { NextRequest, NextResponse } from 'next/server'
import { z }                         from 'zod'
import { createCipheriv, createHash, randomBytes } from 'crypto'
import type { CipherGCM }            from 'crypto'
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
// Format matches credential-scope.ts: gcm:<ivHex>:<ciphertextHex>:<tagHex>

function encryptValue(plaintext: string): string {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('[Credentials] ENCRYPTION_KEY is not set')
  const key    = createHash('sha256').update(raw).digest()
  const iv     = randomBytes(12) // 96-bit IV (GCM standard)
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

// ─── GET /api/admin/credentials ───────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { err } = await guardAdminCreds(req)
  if (err) return err

  const url       = new URL(req.url)
  const projectId = url.searchParams.get('project_id') ?? undefined

  const where = projectId ? { project_id: projectId } : {}

  const credentials = await db.projectCredential.findMany({
    where,
    select:  CRED_SELECT,
    orderBy: { created_at: 'desc' },
  })

  return NextResponse.json({ credentials })
}

// ─── POST /api/admin/credentials ──────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CreateCredentialBody = z.object({
  project_id:   z.string().regex(UUID_RE, 'project_id must be a UUID'),
  name:         z.string().min(1).max(128),
  value:        z.string().min(1), // plaintext — encrypted before storage
  type:         z.enum(['HTTP_BEARER', 'HTTP_BASIC', 'HEADER', 'QUERY_PARAM', 'OAUTH2']),
  inject_as:    z.string().min(1).max(256),
  inject_fmt:   z.string().min(1).max(256),
  host_pattern: z.string().min(1).max(256),
  path_pattern: z.string().max(256).optional(),
  tool_scope:   z.array(z.string()).optional().default([]),
}).strict()

export async function POST(req: NextRequest) {
  const { caller, err } = await guardAdminCreds(req)
  if (err) return err

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = CreateCredentialBody.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const {
    project_id, name, value, type,
    inject_as, inject_fmt, host_pattern, path_pattern, tool_scope,
  } = parsed.data

  // Verify project exists
  const project = await db.project.findUnique({ where: { id: project_id }, select: { id: true } })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Encrypt before persisting
  const value_enc = encryptValue(value)

  const credential = await db.projectCredential.create({
    data: {
      project_id,
      name,
      value_enc,
      type,
      inject_as,
      inject_fmt,
      host_pattern,
      ...(path_pattern !== undefined && { path_pattern }),
      tool_scope: tool_scope ?? [],
      created_by: caller.userId,
    },
    select: CRED_SELECT,
  })

  return NextResponse.json({ credential }, { status: 201 })
}

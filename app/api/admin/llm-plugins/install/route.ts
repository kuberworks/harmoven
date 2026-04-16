// app/api/admin/llm-plugins/install/route.ts
// POST /api/admin/llm-plugins/install
// Installs an LLM provider plugin from a .hpkg archive.
//
// ── Access control ────────────────────────────────────────────────────────────
// instance_admin only. LLM provider plugins run in-process — only the instance
// administrator should be able to install executable code on the server.
//
// ── Request ───────────────────────────────────────────────────────────────────
// Content-Type: multipart/form-data
// Field: file — the .hpkg archive
//
// ── Response 200 ─────────────────────────────────────────────────────────────
// { pack_id, provider_id, name, version, hot_loaded }
// hot_loaded: true  → plugin active immediately, no restart needed
// hot_loaded: false → plugin on disk, server restart required to activate
//
// ── Plugin format ─────────────────────────────────────────────────────────────
// See lib/marketplace/install-llm-plugin.ts for the .hpkg archive format.
// See scripts/build-llm-plugin.sh to compile a plugin from TS source.

import { NextRequest, NextResponse } from 'next/server'
import { resolveCaller }             from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { installLlmPlugin, LlmPluginError }  from '@/lib/marketplace/install-llm-plugin'

export const config = { api: { bodyParser: false } }

const MAX_FILE_SIZE = 5_000_000  // 5 MB

export async function POST(req: NextRequest) {
  // Auth — instance_admin only
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    assertInstanceAdmin(caller)
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  // Parse form data
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'INVALID_FORM_DATA' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: 'FILE_REQUIRED', message: 'Provide a .hpkg file in the "file" form field.' }, { status: 400 })
  }

  const filename = file instanceof File ? file.name : 'unknown'
  if (!filename.endsWith('.hpkg') && !filename.endsWith('.harmoven.zip')) {
    return NextResponse.json({ error: 'INVALID_EXTENSION', message: 'File must be .hpkg or .harmoven.zip' }, { status: 422 })
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'FILE_TOO_LARGE', message: 'File exceeds 5 MB limit.' }, { status: 422 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  try {
    const result = await installLlmPlugin(buffer)
    return NextResponse.json({
      success:     true,
      pack_id:     result.pack_id,
      provider_id: result.provider_id,
      name:        result.name,
      version:     result.version,
      hot_loaded:  result.hot_loaded,
      message:     result.hot_loaded
        ? `Plugin "${result.name}" installed and active.`
        : `Plugin "${result.name}" installed — restart the server to activate.`,
    })
  } catch (err) {
    if (err instanceof LlmPluginError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 422 })
    }
    console.error('[llm-plugins/install] Unexpected error:', err)
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 })
  }
}

// GET /api/admin/llm-plugins/install — list installed plugins
export async function GET(req: NextRequest) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    assertInstanceAdmin(caller)
  } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }

  const { listInstalledLlmPlugins } = await import('@/lib/marketplace/install-llm-plugin')
  const plugins = listInstalledLlmPlugins()
  return NextResponse.json({ plugins })
}

// app/api/admin/marketplace/registries/[id]/test/route.ts
// POST /api/admin/marketplace/registries/:id/test
// Test-fetch the registry feed → return plugin count or error.
//
// A.3.3 — SEC-15, SEC-16, A.3.4

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin, ForbiddenError, UnauthorizedError } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { decryptValue } from '@/lib/utils/credential-crypto-ext'
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'
import yaml from 'js-yaml'

const PluginEntrySchema = z.object({
  id:              z.string(),
  name:            z.string(),
  version:         z.string(),
  capability_type: z.enum(['domain_pack', 'mcp_skill', 'harmoven_agent', 'js_ts_plugin']),
  author:          z.string().optional(),
  description:     z.string().optional(),
  tags:            z.array(z.string()).optional(),
  download_url:    z.string().optional(),
  content_sha256:  z.string().optional(),
  homepage_url:    z.string().optional(),
  license:         z.string().optional(),
  min_harmoven_version: z.string().optional(),
})

const FeedFormatASchema = z.object({
  schema_version: z.string().optional(),
  plugins:        z.array(PluginEntrySchema),
  total:          z.number().optional(),
})

type RouteParams = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { assertInstanceAdmin(caller) } catch (e) {
    const status = e instanceof UnauthorizedError ? 401 : 403
    return NextResponse.json({ error: status === 401 ? 'Unauthorized' : 'Forbidden' }, { status })
  }
  const { id } = await params

  const reg = await db.marketplaceRegistry.findUnique({ where: { id } })
  if (!reg) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  // SEC-15: SSRF check
  try {
    await assertNotPrivateHost(reg.feed_url)
  } catch {
    await db.auditLog.create({
      data: {
        id:          uuidv7(),
        actor:       caller.userId,
        action_type: 'marketplace_registry_tested',
        payload:     { registry_id: id, outcome: 'ssrf_blocked' },
      },
    })
    return NextResponse.json({ error: 'SSRF_BLOCKED' }, { status: 422 })
  }

  const headers: Record<string, string> = {
    'User-Agent': 'Harmoven/2.0 (+https://harmoven.com)',
    'Accept': 'application/json, application/yaml, text/yaml',
  }

  // SEC-14: decrypt auth header if present
  if (reg.auth_header_enc) {
    try {
      headers['Authorization'] = decryptValue(reg.auth_header_enc)
    } catch {
      // Proceed without auth — decryption failure treated as missing
    }
  }

  let pluginCount: number
  let fetchError: string | undefined
  let status = 'ok'

  try {
    const res = await fetch(reg.feed_url, {
      redirect: 'error',
      signal:   AbortSignal.timeout(10_000),
      headers,
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    const isYaml = contentType.includes('yaml')

    // Max 5MB cap
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 5_000_000) {
      throw new Error('RESPONSE_TOO_LARGE')
    }

    const text = new TextDecoder().decode(buf)
    let parsed: unknown

    if (isYaml || reg.feed_url.endsWith('.yaml') || reg.feed_url.endsWith('.yml')) {
      // SEC-16: YAML parsed with JSON_SCHEMA
      parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA })
    } else {
      parsed = JSON.parse(text)
    }

    if (Array.isArray(parsed)) {
      // Format B — legacy array
      const plugins = parsed.map((p) => PluginEntrySchema.safeParse(p)).filter((r) => r.success)
      pluginCount = plugins.length
    } else {
      const feed = FeedFormatASchema.safeParse(parsed)
      if (!feed.success) throw new Error('INVALID_FEED_FORMAT')
      pluginCount = feed.data.plugins.length
    }

    // Update last_fetched_at + status
    await db.marketplaceRegistry.update({
      where: { id },
      data: {
        last_fetched_at:   new Date(),
        last_fetch_status: 'ok',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
    fetchError = msg.slice(0, 100)
    status = `error: ${fetchError}`
    pluginCount = 0

    await db.marketplaceRegistry.update({
      where: { id },
      data: {
        last_fetched_at:   new Date(),
        last_fetch_status: status.slice(0, 128),
      },
    })
  }

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_registry_tested',
      payload:     { registry_id: id, outcome: fetchError ? 'error' : 'ok', plugin_count: pluginCount },
    },
  })

  if (fetchError) {
    return NextResponse.json({ error: 'FEED_FETCH_FAILED', message: fetchError }, { status: 422 })
  }

  return NextResponse.json({ plugin_count: pluginCount, status: 'ok' })
}

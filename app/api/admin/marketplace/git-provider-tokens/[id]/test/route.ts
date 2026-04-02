// app/api/admin/marketplace/git-provider-tokens/[id]/test/route.ts
// POST /api/admin/marketplace/git-provider-tokens/:id/test
// Test-fetch the provider API verification endpoint.
// Returns HTTP status + rate-limit headers only — no personal data (SEC-46, A.5.4).
//
// Provider verification endpoints:
//   GitHub:    GET https://api.github.com/user
//   GitLab:    GET https://gitlab.com/api/v4/user
//   Bitbucket: GET https://api.bitbucket.org/2.0/user

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { resolveCaller } from '@/lib/auth/resolve-caller'
import { assertInstanceAdmin } from '@/lib/auth/rbac'
import { uuidv7 } from '@/lib/utils/uuidv7'
import { decryptValue } from '@/lib/utils/credential-crypto-ext'
import micromatch from 'micromatch'

type RouteParams = { params: Promise<{ id: string }> }

// Map host patterns to verification URL + expected fields
function getVerificationUrl(hostPattern: string): string | null {
  if (micromatch.isMatch('github.com', hostPattern) || micromatch.isMatch('api.github.com', hostPattern)) {
    return 'https://api.github.com/user'
  }
  if (micromatch.isMatch('gitlab.com', hostPattern) || hostPattern.includes('gitlab')) {
    // Try to construct the GitLab root from the pattern — fallback to gitlab.com
    const host = hostPattern.replace(/^\*\./, 'api.')
    return `https://${host}/api/v4/user`
  }
  if (micromatch.isMatch('bitbucket.org', hostPattern)) {
    return 'https://api.bitbucket.org/2.0/user'
  }
  return null
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const caller = await resolveCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assertInstanceAdmin(caller)
  const { id } = await params

  const tok = await db.gitProviderToken.findUnique({ where: { id } })
  if (!tok) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const verifyUrl = getVerificationUrl(tok.host_pattern)
  if (!verifyUrl) {
    return NextResponse.json({ error: 'NO_VERIFICATION_ENDPOINT', message: 'No known API verification endpoint for this host pattern.' }, { status: 422 })
  }

  let tokenValue: string
  try {
    tokenValue = decryptValue(tok.token_enc)
  } catch {
    return NextResponse.json({ error: 'TOKEN_DECRYPT_FAILED' }, { status: 500 })
  }

  // Format according to type (Bitbucket = Basic auth with user:apppassword)
  const authHeader = tokenValue.includes(':')
    ? `Basic ${Buffer.from(tokenValue).toString('base64')}`
    : `Bearer ${tokenValue}`

  let httpStatus: number
  let rateLimit: Record<string, string | null> = {}
  let testError: string | undefined

  try {
    const res = await fetch(verifyUrl, {
      redirect: 'error',
      signal:   AbortSignal.timeout(8_000),
      headers: {
        'User-Agent':    'Harmoven/2.0 (+https://harmoven.com)',
        'Authorization': authHeader,
        'Accept':        'application/json',
      },
    })
    httpStatus = res.status
    // Collect rate-limit headers only — no body forwarded (SEC-46)
    for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining']) {
      rateLimit[h] = res.headers.get(h)
    }
    rateLimit = Object.fromEntries(Object.entries(rateLimit).filter(([, v]) => v !== null))
  } catch (err) {
    httpStatus = 0
    testError = err instanceof Error ? err.message.slice(0, 100) : 'UNKNOWN'
  }

  await db.auditLog.create({
    data: {
      id:          uuidv7(),
      actor:       caller.userId,
      action_type: 'marketplace_git_token_tested',
      payload:     { token_id: id, verify_url: verifyUrl, http_status: httpStatus },
    },
  })

  if (testError) {
    return NextResponse.json({ error: 'FETCH_FAILED', message: testError }, { status: 422 })
  }

  return NextResponse.json({ http_status: httpStatus, rate_limit: rateLimit })
}

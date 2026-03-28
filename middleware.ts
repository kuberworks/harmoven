// middleware.ts — Next.js edge middleware
// Session guard: redirects unauthenticated requests to /login.
//
// Protected routes: all paths except:
//   - /login, /setup         — public auth/first-run pages
//   - /api/auth/*            — Better Auth endpoints
//   - /api/health            — health check (unauthenticated)
//   - /api/v1/*              — public API v1: Bearer hv1_xxx auth in route handlers
//   - /_next/*, /favicon.*   — Next.js internals and static assets
//
// RBAC is NOT enforced here — middleware only checks session presence.
// Per-route permission checks are done inside each API route handler
// using resolvePermissions() + assertPermissions().
//
// MFA ENFORCEMENT:
//   instance_admin accounts must complete MFA before accessing any route.
//   If 2FA is enabled on the account but not yet verified in this session,
//   the middleware redirects to /auth/two-factor (Better Auth built-in page).
//   This enforces orchestrator.yaml: mfa_required_for_admin: true.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/** Paths that do NOT require an authenticated session. */
const PUBLIC_PATHS = [
  '/login',
  '/setup',
  '/api/auth',
  '/api/health',
  // Public API v1 authenticates via Bearer hv1_xxx (not session cookies).
  // Route handlers call resolveCaller() which validates the Bearer token.
  // Session redirect here would make v1 unreachable for API key clients.
  '/api/v1',
  // Webhook endpoints authenticate via HMAC-SHA256 signature (X-Harmoven-Signature header),
  // not via session cookies. Including here prevents middleware from blocking external
  // webhook deliveries from CI/CD or third-party services.
  '/api/webhooks',
  // Non-sensitive instance policy (mfa_required_for_admin flag) — read by the middleware
  // itself in parallel with get-session. Must be public to avoid a recursive auth loop.
  '/api/instance/policy',
]

/**
 * Paths that instance_admin accounts with pending 2FA can still access.
 * /auth/two-factor  — Better Auth's built-in 2FA challenge page
 * /auth/two-factor/* — 2FA verification sub-routes
 */
const MFA_ALLOWED_PATHS = ['/auth/two-factor']

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))
}

function isMfaAllowed(pathname: string): boolean {
  return MFA_ALLOWED_PATHS.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))
}

/** API routes expect JSON 401, not a redirect to /login. */
function isApiRoute(pathname: string): boolean {
  return pathname.startsWith('/api/')
}

/** Shape of the Better Auth get-session response (minimal subset we need). */
interface BetterAuthSession {
  user?:    { role?: string; twoFactorEnabled?: boolean }
  session?: { twoFactorVerified?: boolean }
}

/** In-memory cache for /api/instance/policy — refreshed every 60 s. */
let policyCache: { mfa_required_for_admin: boolean; until: number } | null = null

/** Fetch instance policy with a 60 s in-memory TTL to avoid per-request DB overhead. */
async function fetchPolicy(base: string): Promise<boolean> {
  const now = Date.now()
  if (policyCache && now < policyCache.until) return policyCache.mfa_required_for_admin
  try {
    const res = await fetch(`${base}/api/instance/policy`)
    if (res.ok) {
      const data = await res.json() as { mfa_required_for_admin?: boolean }
      policyCache = { mfa_required_for_admin: data.mfa_required_for_admin ?? true, until: now + 60_000 }
      return policyCache.mfa_required_for_admin
    }
  } catch { /* ignore — fall back to default */ }
  return true  // default: enforce MFA
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  if (isPublic(pathname)) {
    return NextResponse.next()
  }

  // Better Auth sets a session cookie; verify it by calling the internal session endpoint.
  // We call /api/auth/get-session rather than importing the auth instance directly —
  // middleware runs in the Next.js edge runtime and cannot use Node.js-specific adapters
  // (PrismaClient / @prisma/adapter-pg require Node.js APIs).
  //
  // SECURITY: We build the session URL from the AUTH_URL env variable (a fixed server-
  // controlled value), NOT from request.url. Using request.url would make this call
  // vulnerable to SSRF via a forged Host header — an attacker could redirect the session
  // check to an internal network endpoint. AUTH_URL is set at deploy time and never
  // influenced by the incoming request.
  const authBase = (process.env.AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const sessionUrl = `${authBase}/api/auth/get-session`

  // Fetch session + policy in parallel — policy has a 60 s in-memory cache so the
  // extra HTTP call is only made once per minute per process instance.
  let sessionRes: Response
  let mfaRequiredByDb: boolean
  try {
    ;[sessionRes, mfaRequiredByDb] = await Promise.all([
      fetch(sessionUrl, {
        headers: {
          // Forward cookies so Better Auth can read the session token.
          cookie: request.headers.get('cookie') ?? '',
        },
      }),
      fetchPolicy(authBase),
    ])
  } catch {
    // Network / cold-start failure — fail closed.
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackURL', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // A 429 from get-session means the auth rate limit was exhausted (common in dev when
  // the middleware itself triggers counted calls). Return 503 — not 401 — so clients
  // can distinguish "not authenticated" from "temporarily unavailable".
  if (sessionRes.status === 429) {
    return NextResponse.json(
      { error: 'Service temporarily unavailable, retry shortly' },
      { status: 503 },
    )
  }

  if (sessionRes.ok) {
    const body = await sessionRes.json() as BetterAuthSession | null

    // Better Auth returns null when no session exists.
    if (body === null || typeof body !== 'object') {
      if (isApiRoute(pathname)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('callbackURL', pathname)
      return NextResponse.redirect(loginUrl)
    }
    // If the account has 2FA enabled but the current session has not yet completed the
    // 2FA challenge (twoFactorVerified !== true), redirect to the 2FA challenge page.
    // This prevents a session hijack from bypassing MFA by stealing the session cookie
    // before the 2FA step is completed.
    if (body.user?.role === 'instance_admin') {
      // CVE-HARM-011: MFA enforcement for instance_admin.
      //
      // Precedence (highest → lowest):
      //   1. Env var override (HARMOVEN_ENFORCE_ADMIN_MFA=false + acknowledgement) — always wins
      //   2. DB setting via PATCH /api/admin/security { mfa_required_for_admin: false }
      //   3. Default: enforce (true)
      //
      // Env var misconfiguration (flag set without acknowledgement) → stays enforced + error log.
      const disableRequested    = process.env.HARMOVEN_ENFORCE_ADMIN_MFA === 'false'
      const disableAcknowledged = process.env.HARMOVEN_MFA_DISABLE_ACKNOWLEDGED === 'I_UNDERSTAND_THE_SECURITY_RISK'

      if (disableRequested && !disableAcknowledged) {
        console.error(
          '[harmoven] MISCONFIGURATION: HARMOVEN_ENFORCE_ADMIN_MFA=false is set but '
          + 'HARMOVEN_MFA_DISABLE_ACKNOWLEDGED is missing or incorrect. '
          + 'MFA enforcement remains ACTIVE. '
          + 'Set HARMOVEN_MFA_DISABLE_ACKNOWLEDGED=I_UNDERSTAND_THE_SECURITY_RISK to confirm.',
        )
      }

      // Env var wins when both conditions are met; otherwise fall back to DB setting.
      const envOverrideDisables = disableRequested && disableAcknowledged
      const enforceMfa = envOverrideDisables ? false : mfaRequiredByDb

      if (enforceMfa && body.user?.twoFactorEnabled !== true) {
        console.error(
          `[harmoven] SECURITY: instance_admin "${(body.user as { email?: string }).email ?? 'unknown'}" `
          + `is accessing the system without 2FA configured — blocking access until 2FA is enabled.`,
        )
        if (!isMfaAllowed(pathname)) {
          const mfaSetupUrl = new URL('/auth/two-factor', request.url)
          mfaSetupUrl.searchParams.set('callbackURL', pathname)
          mfaSetupUrl.searchParams.set('setup', '1')
          return NextResponse.redirect(mfaSetupUrl)
        }
      }

      if (!enforceMfa) {
        // MFA enforcement disabled — log a persistent warning on every admin access.
        console.warn(
          `[harmoven] WARNING: MFA enforcement is DISABLED. `
          + `instance_admin "${(body.user as { email?: string }).email ?? 'unknown'}" `
          + `accessed without confirmed 2FA. `
          + (envOverrideDisables ? '(env var override)' : '(DB setting)'),
        )
      }

      if (
        body.user?.twoFactorEnabled === true &&
        body.session?.twoFactorVerified !== true &&
        !isMfaAllowed(pathname)
      ) {
        const mfaUrl = new URL('/auth/two-factor', request.url)
        mfaUrl.searchParams.set('callbackURL', pathname)
        return NextResponse.redirect(mfaUrl)
      }
    }

    return NextResponse.next()
  }

  // No valid session — redirect to /login, preserving the intended path as callbackURL.
  if (isApiRoute(pathname)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const loginUrl = new URL('/login', request.url)
  loginUrl.searchParams.set('callbackURL', pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static  (static files)
     * - _next/image   (image optimization)
     * - favicon.ico   (browser favicon)
     * Use negative lookahead to exclude these.
     */
    '/((?!_next/static|_next/image|favicon\\.ico).*)',
  ],
}

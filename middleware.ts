// middleware.ts — Next.js Node.js runtime middleware
// Session guard: redirects unauthenticated requests to /login.
// First-run guard: redirects any unauthenticated request to /setup when no admin
// account exists yet, and redirects /setup to /login once setup is complete.
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
//
// PERF: runs in Node.js runtime (not Edge) so it can call auth.api.getSession()
// and query the DB directly — eliminates the HTTP loopback calls that
// made every authenticated page request ~30–100 ms slower.

export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth'
import { db }   from '@/lib/db/client'

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
  // First-run setup wizard API routes — public because no admin exists yet.
  // Both routes self-seal with a 409 once setup_complete = true.
  '/api/setup',
]

/**
 * Paths that instance_admin accounts with pending 2FA can still access.
 * /settings/security — where the admin activates TOTP (avoids bootstrap loop).
 * /settings/profile  — needed to reach security tab in some layouts.
 * /api/auth          — Better Auth 2FA API endpoints (enable, verify, etc.).
 */
const MFA_ALLOWED_PATHS = ['/settings/security', '/settings/profile', '/api/auth', '/mfa-setup']

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

/** In-memory cache for setup-status — 5 s while pending, 60 s once complete. */
let setupCache: { setup_required: boolean; until: number } | null = null

/** Check whether the first-run wizard has been completed (direct DB query, cached). */
async function isSetupRequired(): Promise<boolean> {
  const now = Date.now()
  if (setupCache && now < setupCache.until) return setupCache.setup_required
  try {
    const setting = await db.systemSetting.findUnique({ where: { key: 'setup.wizard_complete' } })
    const setupRequired = setting?.value !== 'true'
    // Cache duration depends on state:
    //   - setup complete (stable): 60 s
    //   - setup required (transient): 5 s — short enough that wizard completion
    //     is reflected quickly, long enough to avoid a DB hit on every request.
    setupCache = { setup_required: setupRequired, until: now + (setupRequired ? 5_000 : 60_000) }
    return setupRequired
  } catch { /* DB unavailable — assume setup complete to fail safe */ }
  return false
}

/** In-memory cache for MFA policy — refreshed every 60 s. */
let policyCache: { mfa_required_for_admin: boolean; until: number } | null = null

/** Read the MFA enforcement policy from DB directly (cached 60 s). */
async function isMfaRequiredForAdmin(): Promise<boolean> {
  const now = Date.now()
  if (policyCache && now < policyCache.until) return policyCache.mfa_required_for_admin
  try {
    const row = await db.systemSetting.findUnique({ where: { key: 'security.mfa_required_for_admin' } })
    let mfaRequired = true // default: enforce
    if (row) {
      try { mfaRequired = JSON.parse(row.value) as boolean } catch { /* keep default */ }
    }
    policyCache = { mfa_required_for_admin: mfaRequired, until: now + 60_000 }
    return mfaRequired
  } catch { /* DB unavailable — fail safe: enforce MFA */ }
  return true
}

/**
 * Better Auth's default session cookie name (lib/auth.ts has no `cookieName` override).
 * If the cookie name is changed in lib/auth.ts configuration, update this constant.
 *
 * BUG-001 FIX: Used to fast-exit unauthenticated requests without calling get-session.
 */
const SESSION_COOKIE_NAME = 'better-auth.session_token'

/**
 * Per-request Content-Security-Policy value.
 * Moved from next.config.ts static headers to middleware so a nonce can be
 * injected per-request — required for Next.js App Router RSC inline scripts.
 *
 * Production: nonce + strict-dynamic allows Next.js hydration scripts.
 *   strict-dynamic propagates trust from the nonce to scripts it loads, so
 *   every script src does not need to be whitelisted explicitly.
 * Dev: unsafe-eval + unsafe-inline for HMR.
 */
function buildCsp(nonce: string): string {
  const isProd = process.env.NODE_ENV === 'production'
  return [
    "default-src 'self'",
    isProd
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
      : "script-src 'self' 'unsafe-eval' 'unsafe-inline'",  // HMR in dev
    "style-src 'self' 'unsafe-inline'",  // Tailwind inline styles
    "img-src 'self' data: blob:",
    "font-src 'self'",
    isProd ? "connect-src 'self'" : "connect-src 'self' ws: wss:",  // HMR WebSocket in dev
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

async function handleRequest(request: NextRequest, requestHeaders: Headers): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  // ── First-run guard ──────────────────────────────────────────────────────────
  // If no admin account exists yet, every non-/setup request is redirected to /setup
  // so the wizard runs automatically on first launch.
  // Conversely, once setup is complete, visiting /setup redirects to /login.
  // API routes are exempted — the setup wizard itself calls /api/auth/* and /api/health.
  if (!isApiRoute(pathname)) {
    const setupRequired = await isSetupRequired()
    if (setupRequired && pathname !== '/setup' && !pathname.startsWith('/setup/')) {
      return NextResponse.redirect(new URL('/setup', request.url))
    }
    if (!setupRequired && (pathname === '/setup' || pathname.startsWith('/setup/'))) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
  }

  if (isPublic(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } })
  }

  // BUG-001 FIX — Fast-exit when no session cookie is present.
  //
  // Problem: Better Auth rate-limits ALL auth endpoints (global `rateLimit` config in
  // lib/auth.ts: max=5 per 15 min per IP). The middleware called /api/auth/get-session
  // on EVERY protected request — meaning 5 anonymous requests exhausted the quota and
  // caused get-session to return 429. The middleware then returned 503 to ALL callers
  // (including authenticated ones on the same IP) for 15 minutes.
  //
  // Fix: if the Better Auth session cookie is absent, the caller is definitively
  // unauthenticated — return 401/redirect immediately without calling get-session.
  //
  // SECURITY: this is safe because:
  //   a) The route handler authenticates independently via resolveCaller() + auth.api.getSession()
  //      so a forged cookie name (no valid token) will still be rejected by the route.
  //   b) An attacker who sends the cookie with a forged value will pass this check but
  //      will still be rejected by auth.api.getSession() in the route handler.
  //   c) The policy fetch (fetchPolicy) is NOT rate-limited — it queries /api/instance/policy
  //      which is a public route with its own 60 s in-memory cache, unaffected by this fix.
  if (!request.cookies.has(SESSION_COOKIE_NAME)) {
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackURL', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // Verify the session by calling auth.api.getSession() directly — Node.js runtime
  // allows importing Prisma and the auth instance, eliminating the HTTP loopback
  // that previously added ~30–100 ms to every authenticated request.
  // Retrieve session + MFA policy in parallel (policy is cached 60 s).
  let sessionData: Awaited<ReturnType<typeof auth.api.getSession>>
  let mfaRequiredByDb: boolean
  try {
    ;[sessionData, mfaRequiredByDb] = await Promise.all([
      auth.api.getSession({ headers: request.headers }),
      isMfaRequiredForAdmin(),
    ])
  } catch {
    // DB / auth failure — fail closed.
    if (isApiRoute(pathname)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackURL', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (sessionData !== null && typeof sessionData === 'object') {
    const body = sessionData as { user?: { id?: string; role?: string; twoFactorEnabled?: boolean }; session?: { twoFactorVerified?: boolean } }

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
          `[harmoven] SECURITY: instance_admin user id="${body.user?.id ?? 'unknown'}" `
          + `is accessing the system without 2FA configured — redirecting to security settings.`,
        )
        if (!isMfaAllowed(pathname)) {
          // /auth/two-factor does not exist — redirect to the dedicated MFA setup page.
          // Without this, a freshly-created admin account is locked out (infinite redirect loop).
          return NextResponse.redirect(new URL('/mfa-setup', request.url))
        }
      }

      if (!enforceMfa) {
        // MFA enforcement disabled — log a persistent warning on every admin access.
        // SEC-L-01: log user id, not email — emails are PII and must not appear in logs.
        console.warn(
          `[harmoven] WARNING: MFA enforcement is DISABLED. `
          + `instance_admin user id="${body.user?.id ?? 'unknown'}" `
          + `accessed without confirmed 2FA. `
          + (envOverrideDisables ? '(env var override)' : '(DB setting)'),
        )
      }

      // Note: Better Auth does NOT set a `twoFactorVerified` field on the session.
      // The security guarantee comes from the flow itself: when twoFactorEnabled is true,
      // signIn.email() never creates a session — it creates a short-lived two-factor cookie.
      // A full session cookie (SESSION_COOKIE_NAME) is only set after verifyTotp succeeds.
      // Therefore any valid session for a twoFactorEnabled user is already TOTP-verified.
    }

    return NextResponse.next({ request: { headers: requestHeaders } })
  }

  // No valid session — redirect to /login, preserving the intended path as callbackURL.
  if (isApiRoute(pathname)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const loginUrl = new URL('/login', request.url)
  loginUrl.searchParams.set('callbackURL', pathname)
  return NextResponse.redirect(loginUrl)
}

/**
 * Exported middleware: generates a per-request nonce, injects it into the
 * request headers (so Server Components can read it via headers().get('x-nonce'))
 * and attaches the CSP header to every response.
 *
 * Next.js App Router reads x-nonce to add nonce attributes to the inline
 * <script> tags it generates for RSC hydration — without this they are
 * blocked by 'script-src self' in production.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  const response = await handleRequest(request, requestHeaders)
  response.headers.set('Content-Security-Policy', buildCsp(nonce))
  return response
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

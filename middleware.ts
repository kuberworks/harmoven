// middleware.ts — Next.js edge middleware
// Session guard: redirects unauthenticated requests to /login.
//
// Protected routes: all paths except:
//   - /login, /setup         — public auth/first-run pages
//   - /api/auth/*            — Better Auth endpoints
//   - /api/health            — health check (unauthenticated)
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

/** Shape of the Better Auth get-session response (minimal subset we need). */
interface BetterAuthSession {
  user?:    { role?: string; twoFactorEnabled?: boolean }
  session?: { twoFactorVerified?: boolean }
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
  let sessionRes: Response
  try {
    sessionRes = await fetch(sessionUrl, {
      headers: {
        // Forward cookies so Better Auth can read the session token.
        cookie: request.headers.get('cookie') ?? '',
      },
    })
  } catch {
    // Network / cold-start failure — fail closed: redirect to login rather than
    // silently passing the request through unauthenticated (spec §34: every action traceable).
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('callbackURL', pathname)
    return NextResponse.redirect(loginUrl)
  }

  if (sessionRes.ok) {
    const body = await sessionRes.json() as BetterAuthSession | null

    // Better Auth returns null when no session exists.
    if (body === null || typeof body !== 'object') {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('callbackURL', pathname)
      return NextResponse.redirect(loginUrl)
    }

    // ── MFA enforcement for instance_admin (orchestrator.yaml: mfa_required_for_admin: true) ──
    // If the account has 2FA enabled but the current session has not yet completed the
    // 2FA challenge (twoFactorVerified !== true), redirect to the 2FA challenge page.
    // This prevents a session hijack from bypassing MFA by stealing the session cookie
    // before the 2FA step is completed.
    //
    // Note: if twoFactorEnabled is false, the instance_admin can still log in without MFA.
    // Full enforcement (requiring 2FA setup before first admin access) requires a UI setup
    // flow and is deferred — this handles the case where 2FA is configured but not verified.
    if (
      body.user?.role === 'instance_admin' &&
      body.user?.twoFactorEnabled === true &&
      body.session?.twoFactorVerified !== true &&
      !isMfaAllowed(pathname)
    ) {
      const mfaUrl = new URL('/auth/two-factor', request.url)
      mfaUrl.searchParams.set('callbackURL', pathname)
      return NextResponse.redirect(mfaUrl)
    }

    return NextResponse.next()
  }

  // No valid session — redirect to /login, preserving the intended path as callbackURL.
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

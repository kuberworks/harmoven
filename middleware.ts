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

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/** Paths that do NOT require an authenticated session. */
const PUBLIC_PATHS = [
  '/login',
  '/setup',
  '/api/auth',
  '/api/health',
]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))
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
  const sessionUrl = new URL('/api/auth/get-session', request.url)
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
    const body = await sessionRes.json() as unknown
    // Better Auth returns null when no session exists.
    if (body !== null && typeof body === 'object') {
      return NextResponse.next()
    }
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

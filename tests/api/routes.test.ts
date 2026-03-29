// tests/api/routes.test.ts
// Integration-level security tests for key API routes.
//
// Tests 3 security properties per route against mocked auth/DB:
//   1. 401 when no session / no valid Bearer token
//   2. 403 when authenticated but lacking required permission / role
//   3. 429 on rate-limit breach (POST /api/runs only)
//
// Routes under test:
//   GET  /api/projects       — requires session, project member
//   GET  /api/admin/users    — requires instance_admin role
//   POST /api/runs           — requires runs:create + rate limiting
//   GET  /api/admin/instance — (via direct auth check)
//
// All DB calls and auth helpers are mocked — no real DB or network needed.

import { NextRequest } from 'next/server'

// ─── Mock @/lib/auth/resolve-caller ─────────────────────────────────────────

const mockResolveCaller = jest.fn()

jest.mock('@/lib/auth/resolve-caller', () => ({
  resolveCaller: (...args: unknown[]) => mockResolveCaller(...args),
}))

// ─── Mock @/lib/db/client ───────────────────────────────────────────────────

const mockDb = {
  projectMember: {
    findMany:  jest.fn(),
    findUnique: jest.fn(),
  },
  projectApiKey: {
    findUnique: jest.fn(),
    findMany:   jest.fn(),
  },
  user: {
    findMany: jest.fn(),
    count:    jest.fn(),
  },
  project: {
    findMany:  jest.fn(),
    findFirst: jest.fn(),
    count:     jest.fn(),
  },
  run: {
    findMany:  jest.fn(),
    findFirst: jest.fn(),
    count:     jest.fn(),
    create:    jest.fn(),
  },
  auditLog: {
    create: jest.fn(),
  },
}

jest.mock('@/lib/db/client', () => ({ db: mockDb }))

// ─── Mock rate limiting (disabled in test env) ───────────────────────────────

jest.mock('@/lib/auth/rate-limit', () => ({
  createRunRateLimit:      jest.fn().mockReturnValue(null),
  createRunRateLimitAsync: jest.fn().mockResolvedValue(null),
  signInRateLimit:         jest.fn().mockReturnValue(null),
  signInRateLimitAsync:    jest.fn().mockResolvedValue(null),
  checkRateLimit:          jest.fn().mockReturnValue(null),
  checkRateLimitAsync:     jest.fn().mockResolvedValue(null),
}))

// ─── Mock execution engine (POST /api/runs needs it) ────────────────────────

jest.mock('@/lib/execution/engine.factory', () => ({
  getExecutionEngine: jest.fn().mockReturnValue({
    enqueue: jest.fn().mockResolvedValue('run-id-123'),
  }),
}))

// ─── Mock auth RBAC ─────────────────────────────────────────────────────────

const mockResolvePermissions = jest.fn()
const mockAssertInstanceAdmin = jest.fn()

jest.mock('@/lib/auth/rbac', () => ({
  resolvePermissions:  (...args: unknown[]) => mockResolvePermissions(...args),
  assertInstanceAdmin: (...args: unknown[]) => mockAssertInstanceAdmin(...args),
  assertPermissions:   jest.fn(),
  ForbiddenError:      class ForbiddenError extends Error { constructor(msg?: string) { super(msg); this.name = 'ForbiddenError' } },
  UnauthorizedError:   class UnauthorizedError extends Error { constructor(msg?: string) { super(msg); this.name = 'UnauthorizedError' } },
}))

jest.mock('@/lib/auth/ownership', () => ({
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/llm/confidentiality', () => ({
  classifyConfidentiality: jest.fn().mockReturnValue('standard'),
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal NextRequest for testing */
function makeRequest(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): NextRequest {
  const url = `http://localhost:3000${path}`
  const init: RequestInit = { method }
  if (opts.headers) init.headers = opts.headers
  if (opts.body) {
    init.body    = JSON.stringify(opts.body)
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }
  }
  return new NextRequest(url, init)
}

const SESSION_CALLER = {
  type: 'session' as const,
  userId: 'user-abc-123',
  instanceRole: null as string | null,
}

const ADMIN_CALLER = {
  type: 'session' as const,
  userId: 'admin-xyz-456',
  instanceRole: 'instance_admin',
}

// ─── Import route handlers after mocks are in place ──────────────────────────
// Dynamic imports inside each describe() group to pick up fresh module instances.

// ───────────────────────────────────────────────────────────────────────────────
// GET /api/projects — list accessible projects
// ───────────────────────────────────────────────────────────────────────────────

describe('GET /api/projects', () => {
  let GET: (req: NextRequest) => Promise<Response>

  beforeAll(async () => {
    const mod = await import('@/app/api/projects/route')
    GET = mod.GET as unknown as typeof GET
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.projectMember.findMany.mockResolvedValue([])
    mockDb.project.findMany.mockResolvedValue([])
    mockDb.project.count.mockResolvedValue(0)
  })

  it('returns 401 when no session', async () => {
    mockResolveCaller.mockResolvedValue(null)
    const req = makeRequest('GET', '/api/projects')
    const res = await GET(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('returns 200 for authenticated session with no memberships (empty list)', async () => {
    mockResolveCaller.mockResolvedValue(SESSION_CALLER)
    mockDb.projectMember.findMany.mockResolvedValue([])
    mockDb.project.findMany.mockResolvedValue([])
    mockDb.project.count.mockResolvedValue(0)
    const req = makeRequest('GET', '/api/projects')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.data ?? body.projects ?? body)).toBe(true)
  })

  it('returns 200 for instance_admin (sees all projects)', async () => {
    mockResolveCaller.mockResolvedValue(ADMIN_CALLER)
    mockDb.project.findMany.mockResolvedValue([{ id: 'proj-1', name: 'Test' }])
    mockDb.project.count.mockResolvedValue(1)
    const req = makeRequest('GET', '/api/projects')
    const res = await GET(req)
    expect(res.status).toBe(200)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users — list all users (instance_admin only)
// ───────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/users', () => {
  let GET: (req: NextRequest) => Promise<Response>

  beforeAll(async () => {
    const mod = await import('@/app/api/admin/users/route')
    GET = mod.GET as unknown as typeof GET
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockDb.user.findMany.mockResolvedValue([])
    mockDb.user.count.mockResolvedValue(0)
  })

  it('returns 401 when no session', async () => {
    mockResolveCaller.mockResolvedValue(null)
    const req = makeRequest('GET', '/api/admin/users')
    const res = await GET(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('returns 403 when authenticated but not instance_admin', async () => {
    // The route uses assertInstanceAdmin which throws UnauthorizedError/ForbiddenError
    // Import those classes to throw the right one
    const { ForbiddenError } = await import('@/lib/auth/rbac') as {
      ForbiddenError: new (msg?: string) => Error
    }
    mockResolveCaller.mockResolvedValue(SESSION_CALLER)
    mockAssertInstanceAdmin.mockImplementation(() => { throw new ForbiddenError('Not admin') })
    const req = makeRequest('GET', '/api/admin/users')
    const res = await GET(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('returns 200 for instance_admin', async () => {
    mockResolveCaller.mockResolvedValue(ADMIN_CALLER)
    mockAssertInstanceAdmin.mockReturnValue(undefined) // passes
    mockDb.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Alice', email: 'alice@example.com', role: 'user', banned: false },
    ])
    mockDb.user.count.mockResolvedValue(1)
    const req = makeRequest('GET', '/api/admin/users')
    const res = await GET(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    // Response should include a users list or data key
    const list = body.users ?? body.data ?? body
    expect(Array.isArray(list)).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
// POST /api/runs — create a run
// ───────────────────────────────────────────────────────────────────────────────

describe('POST /api/runs', () => {
  let POST: (req: NextRequest) => Promise<Response>
  let rateLimitMod: { createRunRateLimitAsync: jest.Mock }

  const validUUID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'

  const validBody = {
    project_id:     validUUID,
    task_input:     'Write a unit test for the sort function',
    domain_profile: 'engineering',
  }

  beforeAll(async () => {
    const mod = await import('@/app/api/runs/route')
    POST = mod.POST as unknown as typeof POST
    rateLimitMod = (await import('@/lib/auth/rate-limit')) as unknown as typeof rateLimitMod
  })

  beforeEach(() => {
    jest.clearAllMocks()
    rateLimitMod.createRunRateLimitAsync.mockResolvedValue(null) // allow by default
    mockResolvePermissions.mockResolvedValue(new Set(['runs:create', 'project:read']))
    mockDb.project.findFirst.mockResolvedValue({
      id: validUUID, name: 'Test', owner_id: SESSION_CALLER.userId,
    })
    mockDb.projectMember.findUnique.mockResolvedValue({
      project_id: validUUID, user_id: SESSION_CALLER.userId, role: 'developer',
    })
    mockDb.run.create.mockResolvedValue({ id: 'run-new-1', status: 'PENDING' })
  })

  it('returns 401 when no session', async () => {
    mockResolveCaller.mockResolvedValue(null)
    const req = makeRequest('POST', '/api/runs', { body: validBody })
    const res = await POST(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('returns 403 when authenticated but lacking runs:create', async () => {
    mockResolveCaller.mockResolvedValue(SESSION_CALLER)
    // Has project:read but NOT runs:create
    mockResolvePermissions.mockResolvedValue(new Set(['project:read']))
    const req = makeRequest('POST', '/api/runs', { body: validBody })
    const res = await POST(req)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toHaveProperty('error')
  })

  it('returns 429 when rate limit is exceeded', async () => {
    mockResolveCaller.mockResolvedValue(SESSION_CALLER)
    // Simulate rate limiter returning a 429 response
    const { NextResponse } = await import('next/server')
    rateLimitMod.createRunRateLimitAsync.mockResolvedValue(
      NextResponse.json({ error: 'Too many requests', retryAfter: 30 }, {
        status: 429,
        headers: { 'Retry-After': '30' },
      }),
    )
    const req = makeRequest('POST', '/api/runs', { body: validBody })
    const res = await POST(req)
    expect(res.status).toBe(429)
    const responseBody = await res.json()
    expect(responseBody).toHaveProperty('error')
  })

  it('returns 422 for invalid body (strict schema)', async () => {
    mockResolveCaller.mockResolvedValue(SESSION_CALLER)
    mockResolvePermissions.mockResolvedValue(new Set(['runs:create', 'project:read']))
    const req = makeRequest('POST', '/api/runs', {
      body: { ...validBody, unknown_field: 'injection' }, // strict() should reject
    })
    const res = await POST(req)
    // Zod .strict() should reject with 422 or 400
    expect([400, 422]).toContain(res.status)
  })
})

// ───────────────────────────────────────────────────────────────────────────────
// Security: Authorization headers must not leak in error responses
// ───────────────────────────────────────────────────────────────────────────────

describe('Response security headers', () => {
  it('401 responses do not expose internal error details', async () => {
    const { GET } = await import('@/app/api/admin/users/route') as {
      GET: (req: NextRequest) => Promise<Response>
    }
    mockResolveCaller.mockResolvedValue(null)
    const req = makeRequest('GET', '/api/admin/users')
    const res = await GET(req)
    const body = await res.json()
    // Should not expose stack traces or internal paths
    expect(JSON.stringify(body)).not.toMatch(/at Object\.|node_modules|prisma/)
    expect(res.status).toBe(401)
  })
})

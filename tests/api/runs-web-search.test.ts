// tests/api/runs-web-search.test.ts
// Integration tests for POST /api/runs — enable_web_search persistence.
// Verifies:
//   1. enable_web_search: true → stored in run_config.enable_web_search
//   2. enable_web_search absent → run_config.enable_web_search is false (default)
//   3. enable_web_search: false → run_config.enable_web_search is not stored
//
// All DB, auth, and engine calls are mocked — no real DB or network.

import { NextRequest } from 'next/server'

// ─── Global mocks (before imports) ───────────────────────────────────────────

const mockResolveCaller = jest.fn()
jest.mock('@/lib/auth/resolve-caller', () => ({
  resolveCaller: (...args: unknown[]) => mockResolveCaller(...args),
}))

// Capture the data passed to db.run.create so tests can assert run_config
let capturedRunCreate: Record<string, unknown> | null = null

const mockDb = {
  run: {
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      capturedRunCreate = args.data
      return { id: 'run-ws-test-001', status: 'PENDING', ...args.data }
    }),
    findMany:  jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    count:     jest.fn().mockResolvedValue(0),
  },
  node: {
    createMany: jest.fn().mockResolvedValue({ count: 2 }),
  },
  llmProfile: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  auditLog: {
    create: jest.fn().mockResolvedValue({}),
  },
}
jest.mock('@/lib/db/client', () => ({ db: mockDb }))

jest.mock('@/lib/auth/rate-limit', () => ({
  createRunRateLimit:      jest.fn().mockReturnValue(null),
  createRunRateLimitAsync: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/lib/execution/engine.factory', () => ({
  getExecutionEngine: jest.fn().mockResolvedValue({
    executeRun: jest.fn().mockResolvedValue(undefined),
  }),
}))

jest.mock('@/lib/auth/rbac', () => ({
  resolvePermissions:  jest.fn().mockResolvedValue(new Set(['runs:create', 'runs:read'])),
  assertInstanceAdmin: jest.fn(),
  assertPermissions:   jest.fn(),
  ForbiddenError:      class ForbiddenError extends Error { constructor(msg?: string) { super(msg); this.name = 'ForbiddenError' } },
  UnauthorizedError:   class UnauthorizedError extends Error { constructor(msg?: string) { super(msg); this.name = 'UnauthorizedError' } },
}))

jest.mock('@/lib/auth/ownership', () => ({
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/llm/confidentiality', () => ({
  classifyConfidentiality: jest.fn().mockReturnValue('LOW'),
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/runs', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

const SESSION_CALLER = {
  type:         'session' as const,
  userId:       'user-ws-abc',
  instanceRole: null as string | null,
}

const BASE_BODY = {
  project_id:    '00000000-0000-7000-0000-000000000001',
  task_input:    'Summarise recent AI news',
  domain_profile: 'research_synthesis',
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('POST /api/runs — enable_web_search persistence', () => {
  let POST: (req: NextRequest) => Promise<Response>

  beforeAll(async () => {
    const mod = await import('@/app/api/runs/route')
    POST = mod.POST as unknown as typeof POST
  })

  beforeEach(() => {
    jest.clearAllMocks()
    capturedRunCreate = null
    mockResolveCaller.mockResolvedValue(SESSION_CALLER)
    // Default: no enabled LLM profiles (llm_overrides validation only fires if overrides present)
    mockDb.llmProfile.findMany.mockResolvedValue([])
  })

  it('stores enable_web_search:true in run_config when flag is set', async () => {
    const req = makePostRequest({ ...BASE_BODY, enable_web_search: true })
    const res = await POST(req)

    expect(res.status).toBe(201)

    expect(capturedRunCreate).not.toBeNull()
    const runConfig = capturedRunCreate!['run_config'] as Record<string, unknown>
    expect(runConfig['enable_web_search']).toBe(true)
  })

  it('does NOT store enable_web_search in run_config when flag is absent (default false)', async () => {
    // Omit enable_web_search from body — defaults to false per Zod schema
    const req = makePostRequest(BASE_BODY)
    const res = await POST(req)

    expect(res.status).toBe(201)

    expect(capturedRunCreate).not.toBeNull()
    const runConfig = capturedRunCreate!['run_config'] as Record<string, unknown>
    // false does not get persisted (conditional spread)
    expect(runConfig['enable_web_search']).toBeUndefined()
  })

  it('does NOT store enable_web_search in run_config when explicitly false', async () => {
    const req = makePostRequest({ ...BASE_BODY, enable_web_search: false })
    const res = await POST(req)

    expect(res.status).toBe(201)

    const runConfig = capturedRunCreate!['run_config'] as Record<string, unknown>
    expect(runConfig['enable_web_search']).toBeUndefined()
  })

  it('returns 401 when no session', async () => {
    mockResolveCaller.mockResolvedValue(null)
    const req = makePostRequest({ ...BASE_BODY, enable_web_search: true })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })
})

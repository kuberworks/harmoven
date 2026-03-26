// tests/agents/scaffolding/smoke-test.agent.test.ts
// Unit tests for SmokeTestAgent, PortAllocator, PreviewCascade, RepairAgent.
// Zero network, zero Docker — all external I/O is mocked.

import { jest } from '@jest/globals'

// ─── Mock: child_process.execSync ────────────────────────────────────────────
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}))
import { execSync } from 'child_process'
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>

// ─── Mock: fs ────────────────────────────────────────────────────────────────
jest.mock('fs', () => ({
  existsSync:    jest.fn(),
  readFileSync:  jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync:     jest.fn(),
  unlinkSync:    jest.fn(),
}))
import fs from 'fs'
const mockExistsSync    = fs.existsSync    as jest.MockedFunction<typeof fs.existsSync>
const mockReadFileSync  = fs.readFileSync  as jest.MockedFunction<typeof fs.readFileSync>
const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>

// ─── Mock: fetch ─────────────────────────────────────────────────────────────
const mockFetch = jest.fn<typeof fetch>()
global.fetch = mockFetch as unknown as typeof fetch

// ─── Mock: DB (port allocator) ───────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.MockedFunction<(...a: any[]) => any>

// jest.mock factory cannot reference outer variables — we return a factory-created
// object and retrieve it via jest.requireMock() after the mock is established.
jest.mock('@/lib/db/client', () => ({
  db: {
    previewPort: {
      findUnique: jest.fn(),
      create:     jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}))

// ─── Imports after mocks ─────────────────────────────────────────────────────
import { detectFramework }         from '@/lib/agents/scaffolding/repair.agent'
import { smokeTestUrl, checkRoutes, loadPreviewConfig } from '@/lib/agents/scaffolding/preview-cascade'
import { allocatePreviewPort, releasePreviewPort }      from '@/lib/agents/scaffolding/port-allocator'
import { MockLLMClient }           from '@/lib/llm/mock-client'

// Retrieve the mocked DB after jest.mock() is hoisted
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const previewPortDb: Record<string, AnyMock> =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('@/lib/db/client') as { db: { previewPort: Record<string, AnyMock> } }).db.previewPort

// ─── detectFramework ─────────────────────────────────────────────────────────

describe('detectFramework', () => {
  it('detects next.js', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ dependencies: { next: '^14.0.0' } }) as unknown as string
    )
    expect(detectFramework('/worktree')).toBe('nextjs')
  })

  it('detects vite', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ dependencies: { vite: '^5.0.0' } }) as unknown as string
    )
    expect(detectFramework('/worktree')).toBe('vite')
  })

  it('detects express', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ dependencies: { express: '^4.0.0' } }) as unknown as string
    )
    expect(detectFramework('/worktree')).toBe('express')
  })

  it('returns unknown for empty deps', () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ dependencies: {} }) as unknown as string
    )
    expect(detectFramework('/worktree')).toBe('unknown')
  })

  it('returns unknown when package.json is absent', () => {
    mockExistsSync.mockReturnValue(false)
    expect(detectFramework('/worktree')).toBe('unknown')
  })
})

// ─── smokeTestUrl ─────────────────────────────────────────────────────────────

describe('smokeTestUrl', () => {
  afterEach(() => mockFetch.mockReset())

  it('returns ok:true for 2xx responses', async () => {
    mockFetch.mockResolvedValue({ status: 200, ok: true } as Response)
    const result = await smokeTestUrl('http://localhost:3100/', 5_000)
    expect(result).toEqual({ status: 200, ok: true })
  })

  it('returns ok:false for 5xx responses', async () => {
    mockFetch.mockResolvedValue({ status: 500, ok: false } as Response)
    const result = await smokeTestUrl('http://localhost:3100/', 5_000)
    expect(result).toEqual({ status: 500, ok: false })
  })

  it('returns { status: 0, ok: false } on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await smokeTestUrl('http://localhost:3100/', 5_000)
    expect(result).toEqual({ status: 0, ok: false })
  })
})

// ─── checkRoutes ──────────────────────────────────────────────────────────────

describe('checkRoutes', () => {
  afterEach(() => mockFetch.mockReset())

  it('returns RouteCheck array with descriptions', async () => {
    mockFetch
      .mockResolvedValueOnce({ status: 200, ok: true }  as Response)  // /
      .mockResolvedValueOnce({ status: 404, ok: false } as Response)  // /login
    const results = await checkRoutes('http://localhost:3100', ['/', '/login'])
    expect(results).toHaveLength(2)
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.path).toBe('/')
    expect(results[1]!.ok).toBe(false)
    expect(results[1]!.status).toBe(404)
  })
})

// ─── loadPreviewConfig ────────────────────────────────────────────────────────

describe('loadPreviewConfig', () => {
  it('returns defaults when no env or yaml', () => {
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
    const config = loadPreviewConfig()
    expect(config.mode).toBe('auto')
    expect(config.wildcard_domain).toBe('')
  })

  it('picks up APP_SCAFFOLDING_PREVIEW_MODE from env', () => {
    process.env.APP_SCAFFOLDING_PREVIEW_MODE = 'screenshots'
    const config = loadPreviewConfig()
    expect(config.mode).toBe('screenshots')
    delete process.env.APP_SCAFFOLDING_PREVIEW_MODE
  })
})

// ─── allocatePreviewPort / releasePreviewPort ─────────────────────────────────

describe('port allocator', () => {
  beforeEach(() => {
    previewPortDb.findUnique.mockReset()
    previewPortDb.create.mockReset()
    previewPortDb.deleteMany.mockReset()
  })

  it('allocates port 3100 when range is free', async () => {
    previewPortDb.findUnique.mockResolvedValue(null)   // this run has no port
    previewPortDb.create.mockResolvedValue({ port: 3100, run_id: 'r1' })
    const port = await allocatePreviewPort('r1')
    expect(port).toBe(3100)
    expect(previewPortDb.create).toHaveBeenCalledWith({
      data: { port: 3100, run_id: 'r1' },
    })
  })

  it('returns existing port if already allocated for the run', async () => {
    previewPortDb.findUnique.mockResolvedValue({ port: 3142, run_id: 'r1' })
    const port = await allocatePreviewPort('r1')
    expect(port).toBe(3142)
    expect(previewPortDb.create).not.toHaveBeenCalled()
  })

  it('skips ports that are already in use', async () => {
    // First findUnique: check if run already has a port → null
    // Then port 3100 scan: occupied | port 3101 scan: free
    previewPortDb.findUnique
      .mockResolvedValueOnce(null)               // run has no port
      .mockResolvedValueOnce({ port: 3100, run_id: 'other-run' })  // 3100 taken
      .mockResolvedValueOnce(null)               // 3101 free
    previewPortDb.create.mockResolvedValue({ port: 3101, run_id: 'r2' })
    const port = await allocatePreviewPort('r2')
    expect(port).toBe(3101)
  })

  it('throws PortExhaustedError when all ports are claimed', async () => {
    // First call: check if run already has a port → no
    // All subsequent calls (port scan): every port is taken
    previewPortDb.findUnique
      .mockResolvedValueOnce(null)   // run has no existing port
      .mockResolvedValue({ port: 9999, run_id: 'other' })  // all ports occupied
    const { PortExhaustedError } = await import('@/lib/agents/scaffolding/port-allocator')
    await expect(allocatePreviewPort('r-overflow')).rejects.toBeInstanceOf(PortExhaustedError)
  })

  it('releases port on teardown', async () => {
    previewPortDb.deleteMany.mockResolvedValue({ count: 1 })
    await releasePreviewPort('r1')
    expect(previewPortDb.deleteMany).toHaveBeenCalledWith({ where: { run_id: 'r1' } })
  })
})

// ─── RepairAgent — framework-specific patch prompt ───────────────────────────

describe('repairForSubpath — framework detection + LLM call', () => {
  afterEach(() => {
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
    mockWriteFileSync.mockReset()
    mockExecSync.mockReset()
  })

  it('calls LLM with correct prompt for next.js and writes patched file', async () => {
    // Arrange
    mockExistsSync.mockImplementation((p: unknown) => {
      return (p as string).endsWith('package.json') || (p as string).endsWith('next.config.js')
    })
    mockReadFileSync.mockImplementation(((p: unknown): string => {
      if ((p as string).endsWith('package.json'))
        return JSON.stringify({ dependencies: { next: '^14' } })
      return 'module.exports = {}'
    }) as unknown as typeof fs.readFileSync)
    mockExecSync.mockReturnValue(Buffer.from(''))   // build succeeds

    const llm = new MockLLMClient()
    llm.setNextResponse('module.exports = { basePath: "/preview/r1", assetPrefix: "/preview/r1" }')

    const { repairForSubpath } = await import('@/lib/agents/scaffolding/repair.agent')
    await repairForSubpath('/worktree', '/preview/r1/', llm)

    expect(llm.calls.length).toBe(1)
    expect(llm.calls[0]!.messages[0]!.content).toContain('nextjs')
    expect(mockWriteFileSync).toHaveBeenCalled()
    expect(mockExecSync).toHaveBeenCalledWith(expect.stringMatching(/build/), expect.any(Object))
  })
})

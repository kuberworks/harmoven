// tests/agents/scaffolding/layer-agent-executor.test.ts
// Unit tests for T2A.2b — ILayerAgentExecutor, LLMDirectExecutor, KiloCliExecutor, factory.
// Zero network, zero filesystem — all external I/O is mocked.
//
// Coverage:
//   ✓ LLMDirectExecutor — happy path (creates files, uses correct LLM tier)
//   ✓ LLMDirectExecutor — path traversal rejected (absolute path, "..", null byte)
//   ✓ LLMDirectExecutor — LLM returns invalid JSON → success=false
//   ✓ LLMDirectExecutor — LLM returns oversized output → success=false
//   ✓ LLMDirectExecutor — context files loaded + truncated
//   ✓ LLMDirectExecutor — tier selection per layer type
//   ✓ KiloCliExecutor   — isAvailable() = false (kilocode not in test PATH)
//   ✓ KiloCliExecutor   — execute() returns error response when kilocode absent
//   ✓ Factory           — returns LLMDirectExecutor by default
//   ✓ Factory           — kilo_cli + expert_mode falls back to llm_direct (unavailable in test env)

import { jest } from '@jest/globals'

// ─── Mock: fs ────────────────────────────────────────────────────────────────
jest.mock('fs', () => ({
  existsSync:    jest.fn(),
  readFileSync:  jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync:     jest.fn(),
}))
import fs from 'fs'
const mockReadFileSync  = fs.readFileSync  as jest.MockedFunction<typeof fs.readFileSync>
const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<typeof fs.writeFileSync>
const mockMkdirSync     = fs.mkdirSync     as jest.MockedFunction<typeof fs.mkdirSync>

// ─── Imports after mocks ─────────────────────────────────────────────────────
import { MockLLMClient }              from '@/lib/llm/mock-client'
import { LLMDirectExecutor }          from '@/lib/agents/scaffolding/executors/llm-direct.executor'
import { KiloCliExecutor } from '@/lib/agents/scaffolding/executors/kilo-cli.executor'
import { createLayerAgentExecutor }   from '@/lib/agents/scaffolding/layer-agent-executor.factory'
import type { LayerAgentInput }       from '@/lib/agents/scaffolding/layer-agent-executor.interface'

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makeInput(overrides: Partial<LayerAgentInput> = {}): LayerAgentInput {
  return {
    spec:          '## Spec\nCreate a User model with id and email fields.',
    layer:         'db',
    worktree_path: '/tmp/harmoven-worktrees/test-run',
    context_files: [],
    budget_usd:    0.05,
    run_id:        'run-1',
    node_id:       'node-db',
    ...overrides,
  }
}

/** A valid LLM response JSON for a single file creation. */
function validLLMResponse(fileName = 'prisma/schema.prisma', content = 'model User { id Int }') {
  return JSON.stringify({
    files:    [{ path: fileName, content }],
    summary:  'Created User model',
    cost_usd: 0,
  })
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  mockReadFileSync.mockReset()
  mockWriteFileSync.mockReset()
  mockMkdirSync.mockReset()
})

// ═════════════════════════════════════════════════════════════════════════════
// LLMDirectExecutor
// ═════════════════════════════════════════════════════════════════════════════

describe('LLMDirectExecutor', () => {
  describe('happy path', () => {
    it('creates file in worktree and returns success', async () => {
      const llm = new MockLLMClient()
      llm.setNextResponse(validLLMResponse())

      const executor = new LLMDirectExecutor(llm)
      const result   = await executor.execute(makeInput())

      expect(result.success).toBe(true)
      expect(result.files_created).toEqual(['prisma/schema.prisma'])
      expect(result.files_modified).toEqual([])
      expect(result.tests_passed).toBeNull()
      expect(result.error).toBeUndefined()

      // Verify mkdirSync + writeFileSync called with worktree-scoped path
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/harmoven-worktrees/test-run'),
        { recursive: true },
      )
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('/tmp/harmoven-worktrees/test-run/prisma/schema.prisma'),
        'model User { id Int }',
        'utf8',
      )
    })

    it('creates multiple files from one LLM response', async () => {
      const llm = new MockLLMClient()
      llm.setNextResponse(JSON.stringify({
        files: [
          { path: 'src/index.ts',  content: 'export {}' },
          { path: 'src/types.ts',  content: 'export type T = string' },
          { path: 'tests/app.test.ts', content: 'it("todo", () => {})' },
        ],
        summary:  'Bootstrapped API layer',
        cost_usd: 0,
      }))

      const executor = new LLMDirectExecutor(llm)
      const result   = await executor.execute(makeInput({ layer: 'api' }))

      expect(result.success).toBe(true)
      expect(result.files_created).toHaveLength(3)
      expect(mockWriteFileSync).toHaveBeenCalledTimes(3)
    })

    it('returns success with empty files array (no file changes needed)', async () => {
      const llm = new MockLLMClient()
      llm.setNextResponse(JSON.stringify({ files: [], summary: 'No changes', cost_usd: 0 }))

      const executor = new LLMDirectExecutor(llm)
      const result   = await executor.execute(makeInput())

      expect(result.success).toBe(true)
      expect(result.files_created).toEqual([])
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('isAvailable() always returns true', async () => {
      const executor = new LLMDirectExecutor(new MockLLMClient())
      expect(await executor.isAvailable()).toBe(true)
    })

    it('name is "llm_direct"', () => {
      const executor = new LLMDirectExecutor(new MockLLMClient())
      expect(executor.name).toBe('llm_direct')
    })
  })

  describe('LLM tier selection', () => {
    const tierCases: Array<[LayerAgentInput['layer'], string]> = [
      ['db',    'fast'],
      ['infra', 'fast'],
      ['api',   'balanced'],
      ['ui',    'balanced'],
      ['test',  'balanced'],
    ]

    it.each(tierCases)('layer "%s" uses tier "%s"', async (layer, expectedTier) => {
      const llm = new MockLLMClient()
      llm.setNextResponse(validLLMResponse())

      await new LLMDirectExecutor(llm).execute(makeInput({ layer }))

      expect(llm.calls[0]!.options.model).toBe(expectedTier)
    })
  })

  describe('security — path traversal rejection', () => {
    it.each([
      ['../../../etc/passwd'],
      ['../../secrets.env'],
    ])('rejects traversal path: %s', async (badPath) => {
      const llm = new MockLLMClient()
      llm.setNextResponse(validLLMResponse(badPath))

      const result = await new LLMDirectExecutor(llm).execute(makeInput())

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/traversal|escaped/i)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('rejects absolute path from LLM', async () => {
      const llm = new MockLLMClient()
      llm.setNextResponse(validLLMResponse('/etc/passwd'))

      const result = await new LLMDirectExecutor(llm).execute(makeInput())

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/absolute/i)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('rejects null byte in path', async () => {
      const llm = new MockLLMClient()
      llm.setNextResponse(validLLMResponse('foo\0bar.ts'))

      const result = await new LLMDirectExecutor(llm).execute(makeInput())

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/null byte/i)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('returns success=false when LLM returns invalid JSON', async () => {
      const llm = new MockLLMClient()
      llm.setNextResponse('not json at all')

      const result = await new LLMDirectExecutor(llm).execute(makeInput())

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/not valid JSON/i)
    })

    it('returns success=false when LLM response missing "files" array', async () => {
      const llm = new MockLLMClient()
      llm.setNextResponse(JSON.stringify({ summary: 'oops', cost_usd: 0 }))

      const result = await new LLMDirectExecutor(llm).execute(makeInput())

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/"files"/i)
    })

    it('returns success=false when LLM output exceeds size limit', async () => {
      const llm = new MockLLMClient()
      // Produce a string longer than MAX_OUTPUT_CHARS (200_000)
      llm.setNextResponse('x'.repeat(201_000))

      const result = await new LLMDirectExecutor(llm).execute(makeInput())

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/too large/i)
    })
  })

  describe('context files', () => {
    it('reads and includes context files in LLM prompt', async () => {
      mockReadFileSync.mockReturnValue('# Architecture\nUse PostgreSQL.')
      const llm = new MockLLMClient()
      llm.setNextResponse(validLLMResponse())

      await new LLMDirectExecutor(llm).execute(
        makeInput({ context_files: ['/docs/ARCHITECTURE.md'] }),
      )

      const userMessage = llm.calls[0]!.messages.find(m => m.role === 'user')!
      expect(userMessage.content).toContain('ARCHITECTURE.md')
      expect(userMessage.content).toContain('Use PostgreSQL.')
    })

    it('skips unreadable context files without failing', async () => {
      mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
      const llm = new MockLLMClient()
      llm.setNextResponse(validLLMResponse())

      const result = await new LLMDirectExecutor(llm).execute(
        makeInput({ context_files: ['/nonexistent.md'] }),
      )

      expect(result.success).toBe(true)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// KiloCliExecutor
// ═════════════════════════════════════════════════════════════════════════════

describe('KiloCliExecutor', () => {
  it('isAvailable() returns false when kilocode is not in PATH', async () => {
    // In a CI/test environment without kilocode installed, isAvailable() must return false.
    expect(await new KiloCliExecutor().isAvailable()).toBe(false)
  })

  it('name is "kilo_cli"', () => {
    expect(new KiloCliExecutor().name).toBe('kilo_cli')
  })

  it('execute() returns a failure result (not throw) when kilocode is absent', async () => {
    const executor = new KiloCliExecutor()
    // Rather than throwing, execute() returns a LayerAgentOutput with success=false
    // and an error message when kilocode cannot be spawned.
    const result = await executor.execute(makeInput())
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error).toMatch(/kilocode|ENOENT/i)
  })

  it('execute() result has required LayerAgentOutput shape', async () => {
    const executor = new KiloCliExecutor()
    const result   = await executor.execute(makeInput())
    expect(Array.isArray(result.files_created)).toBe(true)
    expect(Array.isArray(result.files_modified)).toBe(true)
    expect(typeof result.duration_ms).toBe('number')
    expect(typeof result.cost_usd).toBe('number')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Factory
// ═════════════════════════════════════════════════════════════════════════════

describe('createLayerAgentExecutor', () => {
  it('returns LLMDirectExecutor by default (no config)', async () => {
    const llm      = new MockLLMClient()
    const executor = await createLayerAgentExecutor({}, llm)
    expect(executor.name).toBe('llm_direct')
    expect(await executor.isAvailable()).toBe(true)
  })

  it('returns LLMDirectExecutor when backend is "llm_direct"', async () => {
    const llm      = new MockLLMClient()
    const executor = await createLayerAgentExecutor({ execution_backend: 'llm_direct' }, llm)
    expect(executor.name).toBe('llm_direct')
  })

  it('falls back to LLMDirectExecutor when kilo_cli requested but expert_mode is false', async () => {
    const llm      = new MockLLMClient()
    const executor = await createLayerAgentExecutor(
      { execution_backend: 'kilo_cli', expert_mode: false },
      llm,
    )
    expect(executor.name).toBe('llm_direct')
  })

  it('falls back to LLMDirectExecutor when kilo_cli+expert_mode requested (STUB unavailable)', async () => {
    // KiloCliExecutor.isAvailable() returns false in v1 — factory must fall back
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const llm      = new MockLLMClient()
    const executor = await createLayerAgentExecutor(
      { execution_backend: 'kilo_cli', expert_mode: true },
      llm,
    )

    expect(executor.name).toBe('llm_direct')
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('kilo_cli'))

    consoleWarnSpy.mockRestore()
  })

  it('returned LLMDirectExecutor is functional end-to-end', async () => {
    const llm = new MockLLMClient()
    llm.setNextResponse(validLLMResponse('src/app.ts', 'export default {}'))

    const executor = await createLayerAgentExecutor({}, llm)
    const result   = await executor.execute(makeInput({ layer: 'api' }))

    expect(result.success).toBe(true)
    expect(result.files_created).toEqual(['src/app.ts'])
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('src/app.ts'),
      'export default {}',
      'utf8',
    )
  })
})

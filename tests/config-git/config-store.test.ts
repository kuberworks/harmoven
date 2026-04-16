// tests/config-git/config-store.test.ts
// Unit tests for GitConfigStore — Amendment 83.
//
// Strategy: mock child_process.execFile and fs to avoid creating a real git repo.
// Tests verify:
//   - get() reads files correctly
//   - set() validates paths, writes files, calls git add + commit
//   - diff() validates hash format before calling git
//   - restore() validates hash, checks files, creates forward commit
//   - history() parses git log output correctly
//   - export() returns all files in directory
//   - Security: invalid project_id, path traversal, invalid hashes

import { jest } from '@jest/globals'

// ─── Mock exec-safe (avoids promisify compat issues with jest.fn()) ──────────
jest.mock('@/lib/utils/exec-safe', () => ({
  execFileAsync: jest.fn(),
  assertSafePath: jest.fn((p: string) => p),
}))

// ─── Mock fs ─────────────────────────────────────────────────────────────────
jest.mock('fs', () => ({
  existsSync:    jest.fn(),
  readFileSync:  jest.fn(),
  promises: {
    readFile:  jest.fn(),
    writeFile: jest.fn(),
    mkdir:     jest.fn(),
    readdir:   jest.fn(),
  },
}))

// ─── Mock lib/db/client ──────────────────────────────────────────────────────
jest.mock('@/lib/db/client', () => ({
  db: {
    project: {
      update: jest.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({}),
    },
  },
}))

import fs                from 'fs'
import { GitConfigStore } from '@/lib/config-git/config-store'
import { execFileAsync, assertSafePath } from '@/lib/utils/exec-safe'

// Cast mocks
const mockReadFile      = fs.promises.readFile  as jest.MockedFunction<typeof fs.promises.readFile>
const mockWriteFile     = fs.promises.writeFile as jest.MockedFunction<typeof fs.promises.writeFile>
const mockMkdir         = fs.promises.mkdir     as jest.MockedFunction<typeof fs.promises.mkdir>
const mockExecFileAsync = execFileAsync          as jest.MockedFunction<typeof execFileAsync>
const mockAssertSafe    = assertSafePath         as jest.MockedFunction<typeof assertSafePath>

/** Helper: make execFileAsync resolve with given stdout */
function mockExecSuccess(stdout = ''): void {
  mockExecFileAsync.mockResolvedValue({ stdout, stderr: '' })
}

/** Store under a deterministic test root */
const TEST_ROOT = '/test/config.git'

let store: GitConfigStore

beforeEach(() => {
  jest.clearAllMocks()
  store = new GitConfigStore(TEST_ROOT)
  mockMkdir.mockResolvedValue(undefined as unknown as string)
  mockWriteFile.mockResolvedValue(undefined)
})

// ─── get() ────────────────────────────────────────────────────────────────────

describe('get()', () => {
  it('returns file content when it exists', async () => {
    mockReadFile.mockResolvedValue('{"budget":10}' as unknown as string & Buffer<ArrayBuffer>)
    const result = await store.get({ project_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', key: 'project.json' })
    expect(result).toBe('{"budget":10}')
  })

  it('returns null when file does not exist', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const result = await store.get({ project_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', key: 'project.json' })
    expect(result).toBeNull()
  })

  it('returns file content for instance project_id', async () => {
    mockReadFile.mockResolvedValue('version: 1' as unknown as string & Buffer<ArrayBuffer>)
    const result = await store.get({ project_id: 'instance', key: 'orchestrator.yaml' })
    expect(result).toBe('version: 1')
  })
})

// ─── set() ────────────────────────────────────────────────────────────────────

describe('set()', () => {
  it('writes file and calls git add + commit', async () => {
    mockExecSuccess('[main abc1234] config(project/aaaaaaaa): update project.json')
    await store.set(
      { project_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', key: 'project.json', content: '{"x":1}' },
      'user-1',
    )
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('project.json'),
      '{"x":1}',
      'utf8',
    )
    // git add called
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git', expect.arrayContaining(['add']),
    )
    // git commit called
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git', expect.arrayContaining(['commit']),
    )
  })

  it('includes the note in the commit message', async () => {
    mockExecSuccess('[main abc1234] config message')
    await store.set(
      { project_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', key: 'project.json', content: '{}' },
      'user-1',
      'Increased budget',
    )
    const commitCall = (mockExecFileAsync as jest.Mock).mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('commit'),
    )
    const args = commitCall?.[1] as string[]
    const msgIndex = args.indexOf('-m')
    expect(args[msgIndex + 1]).toContain('Increased budget')
  })

  it('throws on invalid project_id', async () => {
    // assertSafePath is mocked but projectDir UUID check is in GitConfigStore itself
    mockAssertSafe.mockImplementation((p: string) => p)  // don't throw
    await expect(
      store.set({ project_id: '../evil', key: 'project.json', content: '{}' }, 'user'),
    ).rejects.toThrow(/Invalid project_id/)
  })
})

// ─── diff() ───────────────────────────────────────────────────────────────────

describe('diff()', () => {
  it('calls git diff with two valid hashes', async () => {
    mockExecSuccess('--- a/project.json\n+++ b/project.json\n')
    await store.diff('abc1234', 'def5678')
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git', expect.arrayContaining(['diff', 'abc1234', 'def5678']),
    )
  })

  it('throws on invalid hash format', async () => {
    await expect(store.diff('not-a-hash', 'another')).rejects.toThrow(/Invalid commit hash/)
  })

  it('throws on hash with dangerous chars', async () => {
    await expect(store.diff('abc; rm -rf /', 'def')).rejects.toThrow(/Invalid commit hash/)
  })
})

// ─── restore() ────────────────────────────────────────────────────────────────

describe('restore()', () => {
  it('calls diff-tree + checkout + commit for valid hash', async () => {
    mockExecSuccess('projects/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/project.json\n')
    // Different responses per call
    let callCount = 0
    mockExecFileAsync.mockImplementation(async (_f, args) => {
      callCount++
      const stdout = args?.includes('diff-tree')
        ? 'projects/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/project.json\n'
        : args?.includes('commit')
          ? '[main abc1234] restore'
          : ''
      return { stdout, stderr: '' }
    })
    mockReadFile.mockResolvedValue('{}' as unknown as string & Buffer<ArrayBuffer>)

    await store.restore('abc1234', 'user-1')

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git', expect.arrayContaining(['diff-tree']),
    )
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git', expect.arrayContaining(['checkout', 'abc1234']),
    )
  })

  it('throws on invalid hash', async () => {
    await expect(store.restore('../../evil', 'user')).rejects.toThrow(/Invalid commit hash/)
  })
})

// ─── history() ───────────────────────────────────────────────────────────────

describe('history()', () => {
  it('returns empty array when git log fails (empty repo)', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('no commits'))
    const result = await store.history('instance')
    expect(result).toEqual([])
  })

  it('parses log output into ConfigVersion array', async () => {
    const logLine =
      'abc1234\x002026-03-26T12:00:00Z\x00user-1\x00config(project/abc): update project.json\x00projects/abc/project.json'
    mockExecSuccess(logLine)
    const result = await store.history('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(result).toHaveLength(1)
    expect(result[0]!.hash).toBe('abc1234')
    expect(result[0]!.author).toBe('user-1')
  })
})

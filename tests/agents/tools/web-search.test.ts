// tests/agents/tools/web-search.test.ts
// Tests: web search executor with Brave, Tavily, DuckDuckGo providers.
// Mocks fetch — zero network calls.
// Spec: llm-tool-use-web-search.feature.md §3.3, §7.1–§7.5

// Mock fetch globally
const mockFetch = jest.fn()
global.fetch = mockFetch

// Mock SSRF guard — we control what passes and what blocks
jest.mock('@/lib/security/ssrf-protection', () => ({
  assertNotPrivateHost: jest.fn(async (url: string) => {
    if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('192.168.')) {
      throw new Error(`SSRF blocked: "${url}" resolves to private IP`)
    }
  }),
}))

import {
  searchBrave,
  searchDuckDuckGo,
  makeWebSearchExecutor,
} from '@/lib/agents/tools/web-search'
import type { ToolCall } from '@/lib/llm/interface'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeToolCall(override: Partial<ToolCall> = {}): ToolCall {
  return {
    id:    'call_001',
    name:  'web_search',
    input: { query: 'test query', max_results: 3 },
    ...override,
  }
}

const braveResponseBody = {
  web: {
    results: [
      { title: 'Result 1', url: 'https://example.com/1', description: 'Snippet 1' },
      { title: 'Result 2', url: 'https://example.com/2', description: 'Snippet 2' },
    ],
  },
}

function mockOkResponse(body: unknown): Response {
  return {
    ok:   true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function mockErrorResponse(status: number): Response {
  return {
    ok:   false,
    status,
    statusText: 'Error',
    json: async () => ({}),
    text: async () => '',
  } as unknown as Response
}

const mockDb = {
  sourceTrustEvent: {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
  },
}

const nodeCtx = { project_id: 'proj-test-001', run_id: 'run-001', node_id: 'n1' }
const defaultRunConfig = { enable_web_search: true }

// Reset fetch mock and rate limit state between tests
beforeEach(() => {
  mockFetch.mockReset()
  mockDb.sourceTrustEvent.createMany.mockReset().mockResolvedValue({ count: 1 })
  // Reset rate limit by using unique project IDs per test suite
})

// ─── searchBrave ──────────────────────────────────────────────────────────────

describe('searchBrave()', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV, BRAVE_SEARCH_API_KEY: 'test-brave-key' }
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('parses Brave results correctly', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse(braveResponseBody))
    const result = await searchBrave('test query', 3)
    expect(result.results).toHaveLength(2)
    expect(result.results[0]!.title).toBe('Result 1')
    expect(result.results[0]!.url).toBe('https://example.com/1')
    expect(result.results[0]!.snippet).toBe('Snippet 1')
  })

  it('throws when BRAVE_SEARCH_API_KEY is not set', async () => {
    delete process.env['BRAVE_SEARCH_API_KEY']
    await expect(searchBrave('test')).rejects.toThrow(/BRAVE_SEARCH_API_KEY/)
  })

  it('throws on non-OK API response', async () => {
    mockFetch.mockResolvedValueOnce(mockErrorResponse(429))
    await expect(searchBrave('test')).rejects.toThrow(/Brave Search API error/)
  })

  it('filters out localhost URLs from results', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse({
      web: {
        results: [
          { title: 'Safe', url: 'https://example.com', description: 'ok' },
          { title: 'Unsafe', url: 'http://localhost:8080/admin', description: 'bad' },
        ],
      },
    }))
    const result = await searchBrave('test')
    expect(result.results.every(r => !r.url.includes('localhost'))).toBe(true)
    expect(result.results).toHaveLength(1)
  })
})

// ─── searchDuckDuckGo ─────────────────────────────────────────────────────────

describe('searchDuckDuckGo()', () => {
  it('parses at least 1 result from mocked HTML', async () => {
    const html = `
      <html><body>
      <a class="result-link" href="https://example.com/ddg">DDG Result</a>
      <td class="result-snippet">A useful snippet about the query.</td>
      </body></html>
    `
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: async () => html,
    } as unknown as Response)
    const result = await searchDuckDuckGo('test query', 3)
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    expect(result.results[0]!.url).toBe('https://example.com/ddg')
    expect(result.results[0]!.title).toBe('DDG Result')
  })

  it('returns empty results when HTML has no result links', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, text: async () => '<html><body>no results</body></html>',
    } as unknown as Response)
    const result = await searchDuckDuckGo('empty test')
    expect(result.results).toHaveLength(0)
  })
})

// ─── makeWebSearchExecutor ────────────────────────────────────────────────────

describe('makeWebSearchExecutor()', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV, BRAVE_SEARCH_API_KEY: 'test-key', WEB_SEARCH_PROVIDER: 'brave' }
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('returns ToolResult with search results for web_search call', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse(braveResponseBody))
    const executor = makeWebSearchExecutor(defaultRunConfig, mockDb, { project_id: 'proj-ef-1' })
    const results = await executor([makeToolCall()])
    expect(results).toHaveLength(1)
    expect(results[0]!.is_error).toBeFalsy()
    expect(results[0]!.content).toContain('<WEB_SEARCH_RESULT>')
    expect(results[0]!.content).toContain('Result 1')
  })

  it('returns is_error=true for unknown tool name', async () => {
    const executor = makeWebSearchExecutor(defaultRunConfig, mockDb, { project_id: 'proj-ef-2' })
    const results = await executor([makeToolCall({ name: 'unknown_tool' })])
    expect(results[0]!.is_error).toBe(true)
  })

  it('returns is_error=true (no throw) when provider is unavailable', async () => {
    delete process.env['BRAVE_SEARCH_API_KEY']
    const executor = makeWebSearchExecutor(defaultRunConfig, mockDb, { project_id: 'proj-ef-3' })
    let threw = false
    let result: Awaited<ReturnType<typeof executor>> | null = null
    try {
      result = await executor([makeToolCall()])
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(result![0]!.is_error).toBe(true)
  })

  it('logs to sourceTrustEvent on successful search', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse(braveResponseBody))
    const executor = makeWebSearchExecutor(defaultRunConfig, mockDb, { project_id: 'proj-ef-4' })
    await executor([makeToolCall()])
    // Allow the non-blocking promise to resolve
    await new Promise(r => setTimeout(r, 10))
    expect(mockDb.sourceTrustEvent.createMany).toHaveBeenCalled()
  })

  it('wraps results in WEB_SEARCH_RESULT tags (prompt injection protection)', async () => {
    mockFetch.mockResolvedValueOnce(mockOkResponse(braveResponseBody))
    const executor = makeWebSearchExecutor(defaultRunConfig, mockDb, { project_id: 'proj-ef-5' })
    const results = await executor([makeToolCall()])
    expect(results[0]!.content).toMatch(/^<WEB_SEARCH_RESULT>/)
    expect(results[0]!.content).toMatch(/<\/WEB_SEARCH_RESULT>$/)
  })
})

// ─── Rate limit ───────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = { ...OLD_ENV, BRAVE_SEARCH_API_KEY: 'rl-key', WEB_SEARCH_PROVIDER: 'brave' }
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('61st call within 1 hour returns is_error=true', async () => {
    // Use a unique project ID for this rate limit test
    const projectId = `proj-rl-${Date.now()}`
    const executor = makeWebSearchExecutor(defaultRunConfig, mockDb, { project_id: projectId })

    // Allow the first 60 calls (they hit the Brave API)
    for (let i = 0; i < 60; i++) {
      mockFetch.mockResolvedValueOnce(mockOkResponse(braveResponseBody))
    }

    // Execute 60 calls
    for (let i = 0; i < 60; i++) {
      await executor([makeToolCall()])
    }

    // 61st call should be rate-limited
    const results = await executor([makeToolCall()])
    expect(results[0]!.is_error).toBe(true)
    expect(results[0]!.content).toContain('rate limit')
  })
})

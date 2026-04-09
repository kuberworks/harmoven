// lib/agents/tools/web-search.ts
// Web search executor with Brave, Tavily, and DuckDuckGo providers.
// Spec: llm-tool-use-web-search.feature.md §3.3, §7.1–§7.5
//
// Security notes:
// - SSRF guard: all result URLs are checked via assertNotPrivateHost() before use.
// - Prompt injection: results are wrapped in <WEB_SEARCH_RESULT> tags so the LLM
//   treats them as external, untrusted data (§7.2).
// - Rate limit: 60 searches/hour per project_id (§7.5).
// - Provider keys are read from process.env — never logged.
// - Graceful degradation: provider failure returns is_error=true, never throws.

import type { ToolCall, ToolResult } from '@/lib/llm/interface'
import type { RunConfig } from '@/lib/execution/run-config'
import { assertNotPrivateHost } from '@/lib/security/ssrf-protection'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebSearchResultItem {
  title:   string
  url:     string
  snippet: string
}

export interface WebSearchResponse {
  query:   string
  results: WebSearchResultItem[]
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

/** In-memory per-project rate limit: max 60 searches per hour. Spec §7.5 */
const rateLimitMap = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(projectId: string): void {
  const now = Date.now()
  const entry = rateLimitMap.get(projectId)
  if (!entry || now - entry.windowStart > 3_600_000) {
    rateLimitMap.set(projectId, { count: 1, windowStart: now })
    return
  }
  if (entry.count >= 60) {
    throw new Error('Web search rate limit exceeded (60/hour per project)')
  }
  entry.count++
}

// ─── Prompt injection wrapper ─────────────────────────────────────────────────

/**
 * Wrap result content in trusted-source tags so the LLM knows this is
 * external, untrusted content (§7.2 — prompt injection protection).
 */
function wrapResultContent(content: string): string {
  return `<WEB_SEARCH_RESULT>\n${content}\n</WEB_SEARCH_RESULT>`
}

// ─── Provider resolver ──────────────────────────────────────────────────────────

/**
 * Return the effective search provider, falling back to duckduckgo when the
 * requested provider requires an API key that is not set in the environment.
 * Logs a warning once so operators can diagnose misconfiguration.
 */
function resolveProvider(requested: string): string {
  if (requested === 'brave' && !process.env['BRAVE_SEARCH_API_KEY']) {
    console.warn('[web-search] BRAVE_SEARCH_API_KEY is not set — falling back to duckduckgo')
    return 'duckduckgo'
  }
  if (requested === 'tavily' && !process.env['TAVILY_API_KEY']) {
    console.warn('[web-search] TAVILY_API_KEY is not set — falling back to duckduckgo')
    return 'duckduckgo'
  }
  return requested
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch {
    await new Promise(r => setTimeout(r, 1_000))
    return fn()
  }
}

// ─── SSRF-safe URL filter ─────────────────────────────────────────────────────

/**
 * Filter out result items whose URL resolves to a private host (SSRF guard §7.1).
 * Invalid or private URLs are silently dropped.
 */
async function filterSafeResults(items: WebSearchResultItem[]): Promise<WebSearchResultItem[]> {
  const results: WebSearchResultItem[] = []
  for (const item of items) {
    try {
      await assertNotPrivateHost(item.url)
      results.push(item)
    } catch {
      // Silently drop SSRF-blocked or invalid URLs
    }
  }
  return results
}

// ─── Provider implementations ─────────────────────────────────────────────────

/**
 * Brave Search API.
 * GET https://api.search.brave.com/res/v1/web/search
 * Requires BRAVE_SEARCH_API_KEY in env.
 */
export async function searchBrave(query: string, maxResults = 5): Promise<WebSearchResponse> {
  const apiKey = process.env['BRAVE_SEARCH_API_KEY']
  if (!apiKey) throw new Error('BRAVE_SEARCH_API_KEY is not set')

  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(maxResults, 10)))

  const response = await fetch(url.toString(), {
    headers: {
      'Accept':              'application/json',
      'X-Subscription-Token': apiKey,
    },
  })

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as Record<string, unknown>
  const webResults = (data['web'] as Record<string, unknown> | undefined)?.['results']
  const rawResults = Array.isArray(webResults) ? webResults as Record<string, unknown>[] : []

  const items: WebSearchResultItem[] = rawResults.map(r => ({
    title:   String(r['title'] ?? ''),
    url:     String(r['url'] ?? ''),
    snippet: String(r['description'] ?? ''),
  }))

  return { query, results: await filterSafeResults(items) }
}

/**
 * Tavily Search API.
 * POST https://api.tavily.com/search
 * Requires TAVILY_API_KEY in env.
 */
export async function searchTavily(query: string, maxResults = 5): Promise<WebSearchResponse> {
  const apiKey = process.env['TAVILY_API_KEY']
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set')

  const response = await fetch('https://api.tavily.com/search', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      api_key:         apiKey,
      query,
      max_results:     Math.min(maxResults, 10),
      search_depth:    'basic',
    }),
  })

  if (!response.ok) {
    throw new Error(`Tavily API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as Record<string, unknown>
  const rawResults = Array.isArray(data['results'])
    ? data['results'] as Record<string, unknown>[]
    : []

  const items: WebSearchResultItem[] = rawResults.map(r => ({
    title:   String(r['title'] ?? ''),
    url:     String(r['url'] ?? ''),
    snippet: String(r['content'] ?? ''),
  }))

  return { query, results: await filterSafeResults(items) }
}

/**
 * DuckDuckGo Instant Answer JSON API (no API key required).
 * GET https://api.duckduckgo.com/?q=...&format=json&no_html=1&skip_disambig=1
 *
 * Note: this is DDG's structured-answer endpoint — it returns AbstractText,
 * Results, and RelatedTopics. Not a full web-search index but covers most
 * informational queries without any API key or bot-detection issues.
 * DDG Lite HTML scraping was removed because DDG now returns bot-challenge
 * pages for automated POST requests (0 results).
 */
export async function searchDuckDuckGo(query: string, maxResults = 5): Promise<WebSearchResponse> {
  const url = new URL('https://api.duckduckgo.com/')
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('no_html', '1')
  url.searchParams.set('skip_disambig', '1')
  url.searchParams.set('t', 'harmoven')

  const response = await fetch(url.toString(), {
    headers: {
      'Accept':     'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; research-assistant/1.0)',
    },
  })

  if (!response.ok) {
    throw new Error(`DuckDuckGo API error: ${response.status} ${response.statusText}`)
  }

  const data  = await response.json() as Record<string, unknown>
  const items: WebSearchResultItem[] = []

  // 1. Top Abstract (e.g. Wikipedia summary)
  const abstractText = typeof data['AbstractText'] === 'string' ? data['AbstractText'] : ''
  const abstractUrl  = typeof data['AbstractURL']  === 'string' ? data['AbstractURL']  : ''
  const abstractSrc  = typeof data['AbstractSource'] === 'string' ? data['AbstractSource'] : 'DuckDuckGo'
  if (abstractText && abstractUrl) {
    items.push({ title: abstractSrc, url: abstractUrl, snippet: abstractText })
  }

  // 2. Direct Results (usually 0–2 items)
  type DdgResult = { FirstURL?: string; Text?: string }
  const directResults = Array.isArray(data['Results']) ? (data['Results'] as DdgResult[]) : []
  for (const r of directResults) {
    if (typeof r.FirstURL === 'string' && typeof r.Text === 'string' && r.FirstURL) {
      items.push({ title: r.Text.slice(0, 120), url: r.FirstURL, snippet: r.Text })
    }
  }

  // 3. RelatedTopics — may contain nested groups (Topics[]) or flat items
  type DdgTopic = { FirstURL?: string; Text?: string; Topics?: DdgTopic[] }
  const relatedTopics = Array.isArray(data['RelatedTopics']) ? (data['RelatedTopics'] as DdgTopic[]) : []
  for (const t of relatedTopics) {
    if (t.Topics) {
      // Nested group
      for (const sub of t.Topics) {
        if (typeof sub.FirstURL === 'string' && typeof sub.Text === 'string' && sub.FirstURL) {
          items.push({ title: sub.Text.slice(0, 120), url: sub.FirstURL, snippet: sub.Text })
        }
      }
    } else if (typeof t.FirstURL === 'string' && typeof t.Text === 'string' && t.FirstURL) {
      items.push({ title: t.Text.slice(0, 120), url: t.FirstURL, snippet: t.Text })
    }
  }

  const capped = items.slice(0, maxResults)
  return { query, results: await filterSafeResults(capped) }
}

// ─── Context types ────────────────────────────────────────────────────────────

export interface WebSearchNodeCtx {
  project_id: string
  run_id?:    string
  node_id?:   string
}

// DB interface (only what web-search needs from db)
export interface WebSearchDb {
  sourceTrustEvent: {
    createMany: (args: {
      data: Array<{
        user_id:     string
        source_type: string
        source_ref:  string
        trust_level: string
        action:      string
        run_id?:     string
        reason?:     string
      }>
    }) => Promise<unknown>
  }
}

// ─── makeWebSearchExecutor ────────────────────────────────────────────────────

/**
 * Build a toolExecutor for web search that's compatible with ChatOptions.toolExecutor.
 *
 * @param runConfig  Parsed RunConfig (contains enable_web_search, etc.)
 * @param db         Prisma (or compatible) client for sourceTrustEvent logging
 * @param nodeCtx    Context (project_id, run_id, node_id) for rate limiting and logging
 * @param emitSse    Optional callback — called after each search with (query, resultCount, iteration, isError)
 *
 * Spec: §3.3 — toolExecutor factory
 */
export function makeWebSearchExecutor(
  runConfig: RunConfig,
  db: WebSearchDb,
  nodeCtx: WebSearchNodeCtx,
  emitSse?: (query: string, resultCount: number, iteration: number, isError: boolean) => void,
): NonNullable<import('@/lib/llm/interface').ChatOptions['toolExecutor']> {
  const defaultProvider = (process.env['WEB_SEARCH_PROVIDER'] ?? 'brave').toLowerCase()
  const activeProvider  = resolveProvider(runConfig.web_search_provider ?? defaultProvider)
  let iteration = 0

  return async (calls: ToolCall[]): Promise<ToolResult[]> => {
    const results: ToolResult[] = []

    for (const call of calls) {
      if (call.name !== 'web_search') {
        results.push({
          tool_call_id: call.id,
          content:      wrapResultContent('Unknown tool: ' + call.name),
          is_error:     true,
        })
        continue
      }

      // Rate limit check
      try {
        checkRateLimit(nodeCtx.project_id)
      } catch (e) {
        results.push({
          tool_call_id: call.id,
          content:      wrapResultContent(
            'Search temporarily unavailable — rate limit reached. Please try again later.',
          ),
          is_error: true,
        })
        continue
      }

      const query      = String(call.input['query'] ?? '')
      const maxResults = typeof call.input['max_results'] === 'number'
        ? Math.min(Math.max(1, Math.floor(call.input['max_results'] as number)), 10)
        : (runConfig.web_search_max_results ?? 5)

      let searchResponse: WebSearchResponse | null = null
      let searchError: string | null = null

      try {
        const doSearch = () => {
          if (activeProvider === 'tavily')     return searchTavily(query, maxResults)
          if (activeProvider === 'duckduckgo') return searchDuckDuckGo(query, maxResults)
          return searchBrave(query, maxResults) // default: brave
        }
        searchResponse = await withRetry(doSearch)
      } catch (primaryErr) {
        // Runtime cascade: if the primary provider fails (key invalid, quota, outage),
        // try DuckDuckGo as a last-resort fallback before giving up.
        if (activeProvider !== 'duckduckgo') {
          console.warn(
            `[web-search] ${activeProvider} failed (${primaryErr instanceof Error ? primaryErr.message : primaryErr}) — falling back to duckduckgo`,
          )
          try {
            searchResponse = await withRetry(() => searchDuckDuckGo(query, maxResults))
          } catch (ddgErr) {
            searchError = 'Search service is temporarily unavailable. Please try again later.'
            console.error('[web-search] duckduckgo fallback also failed:', ddgErr instanceof Error ? ddgErr.message : ddgErr)
          }
        } else {
          searchError = 'Search service is temporarily unavailable. Please try again later.'
          console.error('[web-search] provider error:', primaryErr instanceof Error ? primaryErr.message : primaryErr)
        }
      }

      // Log the search event to DB (non-blocking — failures are ignored)
      const sourceTrustData = {
        user_id:     nodeCtx.project_id, // project scoped
        source_type: 'web_search',
        source_ref:  query.slice(0, 500),
        trust_level: 'EXTERNAL',
        action:      searchError ? 'blocked' : 'allowed',
        run_id:      nodeCtx.run_id,
        reason:      searchError ?? undefined,
      }
      db.sourceTrustEvent.createMany({ data: [sourceTrustData] }).catch(err =>
        console.error('[web-search] sourceTrustEvent logging failed:', err),
      )

      if (searchError || !searchResponse) {
        iteration++
        emitSse?.(query, 0, iteration, true)
        results.push({
          tool_call_id: call.id,
          content:      wrapResultContent(searchError ?? 'No results available.'),
          is_error:     true,
        })
        continue
      }

      // Format results
      if (searchResponse.results.length === 0) {
        iteration++
        emitSse?.(query, 0, iteration, false)
        results.push({
          tool_call_id: call.id,
          content:      wrapResultContent(`No results found for: "${query}"`),
        })
        continue
      }

      const formatted = searchResponse.results
        .map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`)
        .join('\n\n')

      iteration++
      emitSse?.(query, searchResponse.results.length, iteration, false)

      results.push({
        tool_call_id: call.id,
        content:      wrapResultContent(`Search results for: "${query}"\n\n${formatted}`),
      })
    }

    return results
  }
}

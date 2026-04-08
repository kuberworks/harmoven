// lib/agents/tools/registry.ts
// Tool registry — defines all built-in tool definitions for agent use.
// Spec: llm-tool-use-web-search.feature.md §3.2

import type { ToolDefinition, ToolParameterSchema } from '@/lib/llm/interface'

/**
 * WEB_SEARCH_TOOL — standard ToolDefinition for real-time web search.
 * Supports Brave, Tavily, and DuckDuckGo providers.
 * Spec: §3.1 — "current, real-time information"
 */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for current, real-time information. ' +
    'Use this tool when the user needs up-to-date facts, news, prices, documentation, ' +
    'or any information that may have changed since your training data cutoff. ' +
    'Returns a list of relevant web search results with titles, URLs, and snippets.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type:        'string',
        description: 'The search query. Be specific and concise for best results.',
      } satisfies ToolParameterSchema,
      max_results: {
        type:        'integer',
        description: 'Maximum number of results to return (1–10, default 5).',
        minimum:     1,
        maximum:     10,
      } satisfies ToolParameterSchema,
    },
    required: ['query'],
  },
}

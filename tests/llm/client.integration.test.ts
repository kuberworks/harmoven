// tests/llm/client.integration.test.ts
// Integration test for DirectLLMClient — T1.9.
//
// Runs ONLY when HARMOVEN_LLM_TIER=haiku AND ANTHROPIC_API_KEY is set.
// In CI / normal unit-test runs, this file is skipped entirely.
//
// Usage:
//   HARMOVEN_LLM_TIER=haiku ANTHROPIC_API_KEY=sk-ant-... npm test -- client.integration
//
// What is verified:
//   1. DirectLLMClient.chat() with tier='fast' resolves to claude-haiku profile
//   2. A real API call returns a non-empty response
//   3. tokensIn > 0 and tokensOut > 0
//   4. stream() delivers onChunk calls and returns same content

import { DirectLLMClient } from '@/lib/llm/client'
import { loadActiveProfiles } from '@/lib/llm/profiles'

const SHOULD_RUN =
  process.env.HARMOVEN_LLM_TIER === 'haiku' &&
  Boolean(process.env.ANTHROPIC_API_KEY)

// Jest test timeout: real LLM calls can take up to 30 s
jest.setTimeout(30_000)

// Helper — create a client pre-configured with only the haiku profile
function makeHaikuClient(): DirectLLMClient {
  const profiles = loadActiveProfiles(['claude-haiku-4-5-20251001'])
  return new DirectLLMClient(profiles)
}

describe('DirectLLMClient — Anthropic integration (claude-haiku)', () => {
  const runIf = SHOULD_RUN ? it : it.skip

  runIf('chat() with tier=fast returns a real response', async () => {
    const client = makeHaikuClient()
    const result = await client.chat(
      [{ role: 'user', content: 'Reply with exactly: HARMOVEN_OK' }],
      { model: 'fast', maxTokens: 32 },
    )

    expect(typeof result.content).toBe('string')
    expect(result.content.trim().length).toBeGreaterThan(0)
    expect(result.tokensIn).toBeGreaterThan(0)
    expect(result.tokensOut).toBeGreaterThan(0)
    expect(result.model).toContain('haiku')
  })

  runIf('chat() with system message works correctly', async () => {
    const client = makeHaikuClient()
    const result = await client.chat(
      [
        { role: 'system', content: 'You are a test assistant. Respond in exactly 3 words.' },
        { role: 'user',   content: 'What is 1+1?' },
      ],
      { model: 'fast', maxTokens: 32 },
    )

    expect(result.content.trim().length).toBeGreaterThan(0)
    expect(result.tokensIn).toBeGreaterThan(0)
  })

  runIf('stream() delivers chunks via onChunk callback', async () => {
    const client  = makeHaikuClient()
    const chunks: string[] = []

    const result = await client.stream(
      [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
      { model: 'fast', maxTokens: 64 },
      chunk => chunks.push(chunk),
    )

    expect(chunks.length).toBeGreaterThan(0)
    expect(result.content.length).toBeGreaterThan(0)
    // Concatenated chunks must equal the final content
    const assembled = chunks.join('')
    expect(assembled).toBe(result.content)
    expect(result.tokensIn).toBeGreaterThan(0)
    expect(result.tokensOut).toBeGreaterThan(0)
  })

  runIf('AbortSignal aborts an in-flight request', async () => {
    const client  = makeHaikuClient()
    const controller = new AbortController()

    // Abort immediately after starting
    const promise = client.chat(
      [{ role: 'user', content: 'Write a long essay about the history of the universe.' }],
      { model: 'fast', maxTokens: 2048, signal: controller.signal },
    )
    controller.abort()

    await expect(promise).rejects.toThrow()
  })

  runIf('chat() with pre-aborted signal rejects without network call', async () => {
    const client     = makeHaikuClient()
    const controller = new AbortController()
    controller.abort()

    await expect(
      client.chat(
        [{ role: 'user', content: 'Hello' }],
        { model: 'fast', maxTokens: 16, signal: controller.signal },
      ),
    ).rejects.toThrow()
  })

  // Unit-level test — always runs (no API key needed)
  it('chat() rejects on unknown model/tier', async () => {
    const client = makeHaikuClient()
    await expect(
      client.chat([], { model: 'ultra' }),
    ).rejects.toThrow('[DirectLLMClient] Unknown model/tier/id')
  })

  it('selectByTier returns haiku for "fast" tier', () => {
    const { selectByTier } = require('@/lib/llm/selector')
    const profiles = loadActiveProfiles(['claude-haiku-4-5-20251001'])
    const profile  = selectByTier('fast', profiles)
    expect(profile).not.toBeNull()
    expect(profile!.id).toBe('claude-haiku-4-5-20251001')
    expect(profile!.provider).toBe('anthropic')
    expect(profile!.tier).toBe('fast')
  })

  it('loadActiveProfiles returns only requested profiles', () => {
    const profiles = loadActiveProfiles(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'])
    expect(profiles).toHaveLength(2)
    expect(profiles[0]!.id).toBe('claude-haiku-4-5-20251001')
    expect(profiles[1]!.id).toBe('claude-sonnet-4-6')
  })

  it('loadActiveProfiles falls back to haiku when empty array given', () => {
    const profiles = loadActiveProfiles([])
    expect(profiles).toHaveLength(1)
    expect(profiles[0]!.id).toBe('claude-haiku-4-5-20251001')
  })

  it('loadActiveProfiles warns and skips unknown profiles', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => { /* noop */ })
    const profiles   = loadActiveProfiles(['unknown-model-xyz'])
    expect(profiles).toHaveLength(0)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})

// tests/llm/image-client.test.ts
// Unit tests for DirectImageClient — mocks global fetch.

import { DirectImageClient, createImageClient } from '@/lib/llm/image-client'
import type { LlmProfileConfig } from '@/lib/llm/profiles'

const OPENAI_PROFILE: LlmProfileConfig = {
  id:                       'dall-e-3',
  provider:                 'openai',
  model_string:             'dall-e-3',
  tier:                     'balanced',
  context_window:           0,
  cost_per_1m_input_tokens:  0,
  cost_per_1m_output_tokens: 0,
  jurisdiction:             'us',
  trust_tier:               1,
  task_type_affinity:       [],
  api_key_env:              'OPENAI_API_KEY',
}

const GOOGLE_PROFILE: LlmProfileConfig = {
  id:                       'imagen-3',
  provider:                 'google',
  model_string:             'imagen-3.0-generate-001',
  tier:                     'balanced',
  context_window:           0,
  cost_per_1m_input_tokens:  0,
  cost_per_1m_output_tokens: 0,
  jurisdiction:             'us',
  trust_tier:               1,
  task_type_affinity:       [],
  api_key_env:              'GOOGLE_API_KEY',
}

describe('createImageClient', () => {
  it('returns DirectImageClient for openai provider', () => {
    const client = createImageClient(OPENAI_PROFILE)
    expect(client).toBeInstanceOf(DirectImageClient)
  })

  it('returns DirectImageClient for google provider', () => {
    const client = createImageClient(GOOGLE_PROFILE)
    expect(client).toBeInstanceOf(DirectImageClient)
  })

  it('throws for ollama provider', () => {
    const ollamaProfile = { ...OPENAI_PROFILE, provider: 'ollama' }
    expect(() => createImageClient(ollamaProfile as LlmProfileConfig)).toThrow(
      'Ollama does not support image generation',
    )
  })
})

describe('DirectImageClient — OpenAI backend', () => {
  const originalFetch = global.fetch
  const originalEnv   = process.env['OPENAI_API_KEY']

  beforeEach(() => {
    process.env['OPENAI_API_KEY'] = 'test-key'
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalEnv === undefined) delete process.env['OPENAI_API_KEY']
    else process.env['OPENAI_API_KEY'] = originalEnv
  })

  it('returns Buffer with image/png mimeType for OpenAI response', async () => {
    const fakeBytes = Buffer.from('fake-png-data')
    const b64       = fakeBytes.toString('base64')

    global.fetch = jest.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({ data: [{ b64_json: b64 }] }),
    } as unknown as Response)

    const client = new DirectImageClient(OPENAI_PROFILE, 'openai')
    const result = await client.generateImage('a red cat', { model: 'dall-e-3' })

    expect(result.bytes).toBeInstanceOf(Buffer)
    expect(result.bytes.toString()).toBe('fake-png-data')
    expect(result.mimeType).toBe('image/png')
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('throws on non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok:   false,
      status: 429,
      text: async () => 'rate limited',
    } as unknown as Response)

    const client = new DirectImageClient(OPENAI_PROFILE, 'openai')
    await expect(
      client.generateImage('test', { model: 'dall-e-3' }),
    ).rejects.toThrow('429')
  })

  it('throws when api key is missing', async () => {
    delete process.env['OPENAI_API_KEY']
    const client = new DirectImageClient(OPENAI_PROFILE, 'openai')
    await expect(
      client.generateImage('test', { model: 'dall-e-3' }),
    ).rejects.toThrow('Missing API key')
  })
})

describe('DirectImageClient — Gemini backend', () => {
  const originalFetch = global.fetch
  const originalEnv   = process.env['GOOGLE_API_KEY']

  beforeEach(() => {
    process.env['GOOGLE_API_KEY'] = 'test-key'
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalEnv === undefined) delete process.env['GOOGLE_API_KEY']
    else process.env['GOOGLE_API_KEY'] = originalEnv
  })

  it('returns Buffer for Gemini Imagen response', async () => {
    const fakeBytes = Buffer.from('fake-image-data')
    const b64       = fakeBytes.toString('base64')

    global.fetch = jest.fn().mockResolvedValue({
      ok:   true,
      json: async () => ({
        generatedImages: [{ image: { imageBytes: b64 } }],
      }),
    } as unknown as Response)

    const client = new DirectImageClient(GOOGLE_PROFILE, 'gemini')
    const result = await client.generateImage('a blue sky', { model: 'imagen-3.0-generate-001' })

    expect(result.bytes).toBeInstanceOf(Buffer)
    expect(result.mimeType).toBe('image/png')
  })
})

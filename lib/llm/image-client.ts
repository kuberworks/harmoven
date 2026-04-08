// lib/llm/image-client.ts
// DirectImageClient — production image generation client.
// Supports OpenAI DALL-E, Gemini Imagen, LiteLLM proxy.
// Spec: multi-format-artifact-output.feature.md Part 4 §4.3
//
// Provider routing:
//   openai / cometapi → OpenAI images.generate (b64_json)
//   google            → Gemini models.generateImages (Imagen)
//   litellm           → OpenAI-compatible proxy
//   ollama            → throws (not supported)

import type { IImageClient, ImageGenOptions, ImageGenResult } from './image-interface'
import type { LlmProfileConfig } from './profiles'

// ─── Helper ──────────────────────────────────────────────────────────────────

function toGeminiAspect(w: number, h: number): string {
  const ratio = w / h
  if (ratio >= 1.7)  return '16:9'
  if (ratio >= 1.3)  return '4:3'
  if (ratio <= 0.6)  return '9:16'
  if (ratio <= 0.8)  return '3:4'
  return '1:1'
}

// ─── DirectImageClient ───────────────────────────────────────────────────────

type Backend = 'openai' | 'gemini'

export class DirectImageClient implements IImageClient {
  private readonly profile: LlmProfileConfig
  private readonly backend: Backend

  constructor(profile: LlmProfileConfig, backend: Backend) {
    this.profile = profile
    this.backend = backend
  }

  async generateImage(prompt: string, options: ImageGenOptions): Promise<ImageGenResult> {
    const { model, width = 1024, height = 1024, quality, style, signal } = options

    if (this.backend === 'openai') {
      return this._openai(prompt, { model, width, height, quality, style, signal })
    }
    if (this.backend === 'gemini') {
      return this._gemini(prompt, { model, width, height, signal })
    }
    throw new Error(`Unsupported image generation backend: ${this.backend as string}`)
  }

  // ── OpenAI / CometAPI / LiteLLM ─────────────────────────────────────────

  private async _openai(
    prompt: string,
    opts: { model: string; width: number; height: number; quality?: 'standard' | 'hd'; style?: string; signal?: AbortSignal },
  ): Promise<ImageGenResult> {
    const apiKey = this.profile.api_key_enc
      ?? (this.profile.api_key_env ? process.env[this.profile.api_key_env] : undefined)
    if (!apiKey) {
      throw new Error(`[DirectImageClient] Missing API key for provider "${this.profile.provider}"`)
    }

    const baseUrl = this.profile.base_url ?? 'https://api.openai.com'
    const url     = `${baseUrl}/v1/images/generations`

    const body: Record<string, unknown> = {
      model:           opts.model,
      prompt,
      n:               1,
      size:            `${opts.width}x${opts.height}`,
      response_format: 'b64_json',
    }
    if (opts.quality) body['quality'] = opts.quality
    if (opts.style)   body['style']   = opts.style

    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body:   JSON.stringify(body),
      signal: opts.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`[DirectImageClient] OpenAI images API ${res.status}: ${text.slice(0, 200)}`)
    }

    const data = await res.json() as { data?: Array<{ b64_json?: string }>; usage?: { total_tokens?: number } }
    const b64 = data.data?.[0]?.b64_json
    if (!b64) {
      throw new Error('[DirectImageClient] OpenAI response missing b64_json')
    }

    const bytes = Buffer.from(b64, 'base64')
    // Estimate cost — DALL-E 3 standard 1024 ≈ $0.04 per image
    const costUsd = 0.04

    return { bytes, mimeType: 'image/png', model: opts.model, costUsd }
  }

  // ── Gemini / Imagen ──────────────────────────────────────────────────────

  private async _gemini(
    prompt: string,
    opts: { model: string; width: number; height: number; signal?: AbortSignal },
  ): Promise<ImageGenResult> {
    const apiKey = this.profile.api_key_enc
      ?? (this.profile.api_key_env ? process.env[this.profile.api_key_env] : undefined)
    if (!apiKey) {
      throw new Error('[DirectImageClient] Missing API key for Google/Gemini provider')
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateImages?key=${apiKey}`

    const body = {
      prompt:    { text: prompt },
      config: {
        numberOfImages: 1,
        aspectRatio:    toGeminiAspect(opts.width, opts.height),
      },
    }

    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  opts.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`[DirectImageClient] Gemini images API ${res.status}: ${text.slice(0, 200)}`)
    }

    const data = await res.json() as {
      generatedImages?: Array<{ image?: { imageBytes?: string } }>
    }
    const b64 = data.generatedImages?.[0]?.image?.imageBytes
    if (!b64) {
      throw new Error('[DirectImageClient] Gemini response missing imageBytes')
    }

    const bytes = Buffer.from(b64, 'base64')
    // Imagen 3 — approximate cost per image
    const costUsd = 0.04

    return { bytes, mimeType: 'image/png', model: opts.model, costUsd }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Instantiate a DirectImageClient from a resolved LlmProfileConfig.
 * Throws for providers that do not support image generation (ollama).
 */
export function createImageClient(profile: LlmProfileConfig): DirectImageClient {
  switch (profile.provider) {
    case 'openai':
    case 'cometapi':
    case 'litellm':
      return new DirectImageClient(profile, 'openai')
    case 'google':
      return new DirectImageClient(profile, 'gemini')
    case 'ollama':
      throw new Error('Ollama does not support image generation')
    default:
      throw new Error(`Provider "${profile.provider}" does not support image generation`)
  }
}

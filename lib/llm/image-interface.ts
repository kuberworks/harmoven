// lib/llm/image-interface.ts
// IImageClient — stable contract for image generation providers.
// Separate from ILLMClient (text) — spec §4.2, decision J.
//
// Implementations:
//   DirectImageClient → lib/llm/image-client.ts (production)

export interface ImageGenOptions {
  model:           string
  width?:          number          // default: 1024
  height?:         number          // default: 1024
  quality?:        'standard' | 'hd'
  style?:          string
  negativePrompt?: string
  signal?:         AbortSignal
}

export interface ImageGenResult {
  bytes:    Buffer
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  model:    string
  costUsd:  number
}

export interface IImageClient {
  generateImage(prompt: string, options: ImageGenOptions): Promise<ImageGenResult>
}

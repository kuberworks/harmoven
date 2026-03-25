// lib/llm-connect/ollama-detect.ts
// Ollama local auto-detection — TECHNICAL.md §21.5.
//
// Probes well-known local endpoints for an Ollama API server.
// Called from the LLM connection panel UI and from DirectLLMClient
// when provider = 'ollama'.

const OLLAMA_ENDPOINTS = [
  'http://localhost:11434',   // default macOS/Linux
  'http://localhost:11435',   // alternative port
  'http://127.0.0.1:11434',
]

export interface OllamaModel {
  name:    string
  size?:   number
  digest?: string
}

export type OllamaStatus =
  | { found: true;  endpoint: string; models: string[] }
  | { found: false }

/**
 * Probe well-known local sockets for an Ollama API server.
 * Returns the first responsive endpoint and the list of installed models.
 * Timeout per endpoint: 2 s (spec §21.5).
 */
export async function detectOllama(): Promise<OllamaStatus> {
  for (const endpoint of OLLAMA_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) {
        const data = await response.json() as { models?: OllamaModel[] }
        const models = (data.models ?? []).map(m => m.name)
        return { found: true, endpoint, models }
      }
    } catch {
      // try next endpoint
    }
  }
  return { found: false }
}

// ─── Ollama Cloud (optional) ──────────────────────────────────────────────────
// Section 21.6 — Same API as local Ollama, hosted at ollama.com.

export interface ValidationResult {
  valid:   boolean
  error?:  string
}

export interface TestResult {
  success: boolean
  reason?: string
}

export function validateOllamaCloudKey(key: string): ValidationResult {
  const trimmed = key.trim()
  if (trimmed.length < 20) {
    return { valid: false, error: 'Key too short — paste the full key' }
  }
  return { valid: true }
}

export async function testOllamaCloudKey(key: string): Promise<TestResult> {
  try {
    const response = await fetch('https://ollama.com/api/tags', {
      headers: { Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(5_000),
    })
    if (response.ok)           return { success: true }
    if (response.status === 401) return { success: false, reason: 'Invalid key' }
    return { success: true }   // other 2xx
  } catch {
    return { success: false, reason: 'Cannot reach Ollama Cloud' }
  }
}

export async function listOllamaCloudModels(key: string): Promise<string[]> {
  const response = await fetch('https://ollama.com/api/tags', {
    headers: { Authorization: `Bearer ${key}` },
  })
  const data = await response.json() as { models?: OllamaModel[] }
  return (data.models ?? [])
    .map(m => m.name)
    .filter(name => name.includes('-cloud') || name.includes(':cloud'))
}

export interface OllamaClientConfig {
  host:    string
  headers: Record<string, string>
}

/**
 * Return the host + auth headers for an Ollama client.
 * Cloud endpoints (https://ollama.com) require a Bearer token.
 * Local endpoints (http://localhost:*) need no auth.
 */
export function createOllamaClientConfig(endpoint: string, apiKey?: string): OllamaClientConfig {
  const isCloud = endpoint.startsWith('https://ollama.com')
  return {
    host:    endpoint,
    headers: isCloud && apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : {},
  }
}

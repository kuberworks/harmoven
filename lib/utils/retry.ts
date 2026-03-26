// lib/utils/retry.ts
// Exponential backoff retry utility — Amendment 6.C
//
// Retry policy:
//   max_retries: 3
//   delays:      5s → 15s → 45s (×3)
//   jitter:      ±20% of each delay
//
// Usage:
//   const result = await withRetry(() => llm.chat(...), { signal })

export interface RetryOptions {
  /** Maximum number of attempts (default 3). First call counts as attempt 1. */
  maxAttempts?: number
  /** Base delays in ms between attempts. Defaults to [5000, 15000, 45000]. */
  delaysMs?: number[]
  /** Jitter fraction (default 0.2 = ±20%). */
  jitter?: number
  /** AbortSignal — stops retrying if aborted. */
  signal?: AbortSignal
  /** Called before each retry with the error and attempt number (1-based). */
  onRetry?: (err: unknown, attempt: number) => void
}

const DEFAULT_DELAYS_MS = [5_000, 15_000, 45_000]

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function jitteredDelay(baseMs: number, jitter: number): number {
  const factor = 1 - jitter + Math.random() * 2 * jitter // [1-j, 1+j]
  return Math.round(clamp(baseMs * factor, 0, baseMs * 2))
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const id = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(id)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })

/**
 * Returns true for errors that are worth retrying (transient / server-side).
 * Client errors (4xx) or validation errors must NOT be retried — they will
 * never succeed and just waste time and quota.
 */
function isRetriable(err: unknown): boolean {
  // AbortError — never retry (intentional cancellation)
  if (err instanceof DOMException && err.name === 'AbortError') return false

  // Anthropic / OpenAI SDK errors expose a `status` field on the error object
  const status = (err as { status?: number }).status
  if (typeof status === 'number') {
    // 429 = rate limit, 5xx = server error → retriable
    // 4xx (except 429) = client error (bad request, auth, not found) → not retriable
    return status === 429 || status >= 500
  }

  // Network-level errors (ECONNRESET, ETIMEDOUT, fetch TypeError) → retriable
  if (err instanceof TypeError) return true

  const code = (err as { code?: string }).code
  if (typeof code === 'string' && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'].includes(code))
    return true

  // Unknown errors: retry conservatively
  return true
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    delaysMs = DEFAULT_DELAYS_MS,
    jitter = 0.2,
    signal,
    onRetry,
  } = opts

  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      // Never retry on abort
      if (!isRetriable(err)) throw err
      if (attempt === maxAttempts) break
      const delayIdx = Math.min(attempt - 1, delaysMs.length - 1)
      const delayMs = jitteredDelay(delaysMs[delayIdx] ?? 5_000, jitter)
      onRetry?.(err, attempt)
      await sleep(delayMs, signal)
    }
  }
  throw lastErr
}

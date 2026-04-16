// lib/i18n/t.ts
// Amendment 86 — lightweight translation function.
//
// Loads locale JSON files at module initialisation time (Node.js require-style).
// Works in server components, API routes, and anywhere that can import JSON.
//
// Usage (server components / API routes):
//   import { createT } from '@/lib/i18n/t'
//   const t = createT('fr')
//   t('runs.status.running')  // → 'En cours'
//   t('common.ago', { time: '5m' })  // → 'il y a 5m'
//
// For client components, use the <TranslationProvider> + useT() hook defined in
// lib/i18n/client.tsx.

import type { SupportedLocale } from './types'
import { DEFAULT_LOCALE } from './types'

// Import locale JSON files. TypeScript resolves these at compile time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const enMessages = require('@/locales/en.json') as Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frMessages = require('@/locales/fr.json') as Record<string, unknown>

const MESSAGES: Record<SupportedLocale, Record<string, unknown>> = {
  en: enMessages,
  fr: frMessages,
}

/**
 * Walk a nested object following dot-notation path segments.
 * Returns the value at the path or undefined if not found.
 */
function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): string | undefined {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === 'string' ? current : undefined
}

/**
 * Interpolate named placeholders in a message string.
 * `t('common.ago', { time: '5m' })` → 'il y a 5m'
 * Placeholder syntax: {paramName}
 */
function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(
    /\{(\w+)\}/g,
    (_, key) => params[key] ?? `{${key}}`,
  )
}

export type TFunction = (key: string, params?: Record<string, string>) => string

/**
 * Create a translation function for a given locale.
 *
 * Falls back to en.json if:
 *   - The locale is not supported
 *   - A key is missing in the target locale (graceful degradation per Am.86.7)
 */
export function createT(locale: SupportedLocale | string): TFunction {
  const primary = MESSAGES[locale as SupportedLocale] ?? MESSAGES[DEFAULT_LOCALE]
  const fallback = MESSAGES[DEFAULT_LOCALE]

  return function t(key: string, params?: Record<string, string>): string {
    // Try primary locale first, then fall back to English.
    const raw =
      getNestedValue(primary, key) ??
      getNestedValue(fallback, key) ??
      key   // last resort: return the key itself (never show blank)

    return params ? interpolate(raw, params) : raw
  }
}

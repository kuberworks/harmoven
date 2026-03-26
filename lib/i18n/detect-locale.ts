// lib/i18n/detect-locale.ts
// Amendment 86.3 — three-level UI locale detection cascade:
//   1. User preference (User.ui_locale in DB)
//   2. Instance default (orchestrator.yaml → ui.default_locale)
//   3. Browser Accept-Language header
//   Fallback: always 'en'

import type { SupportedLocale } from './types'
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from './types'

/** Minimal shape of what we need from the session user. */
interface SessionUser {
  ui_locale?: string | null
}

/** Minimal shape of what we read from orchestrator.yaml. */
interface OrchestratorConfig {
  ui?: {
    default_locale?: string
  }
}

/**
 * Parse an Accept-Language header and return the first supported locale.
 * e.g. "fr-FR,fr;q=0.9,en;q=0.8" → 'fr'
 */
export function parseAcceptLanguage(header: string): SupportedLocale[] {
  const seen = new Set<string>()
  const results: SupportedLocale[] = []
  for (const part of header.split(',')) {
    const [tag] = part.trim().split(';')
    const base = tag.trim().split('-')[0].toLowerCase()   // 'fr-FR' → 'fr'
    if (!seen.has(base) && SUPPORTED_LOCALES.includes(base as SupportedLocale)) {
      seen.add(base)
      results.push(base as SupportedLocale)
    }
  }
  return results
}

/**
 * Resolve the UI locale for a request using the three-level cascade.
 *
 * @param acceptLanguageHeader - Value of the Accept-Language HTTP header
 * @param user                 - Session user (may be null for unauthenticated)
 * @param instanceConfig       - Parsed orchestrator.yaml (may be null)
 */
export function resolveUILocale(
  acceptLanguageHeader: string | null,
  user?: SessionUser | null,
  instanceConfig?: OrchestratorConfig | null,
): SupportedLocale {
  // Priority 1 — explicit user preference stored on User.ui_locale
  if (user?.ui_locale) {
    const pref = user.ui_locale.toLowerCase().split('-')[0]
    if (SUPPORTED_LOCALES.includes(pref as SupportedLocale)) {
      return pref as SupportedLocale
    }
  }

  // Priority 2 — instance default from orchestrator.yaml
  const instanceLocale = instanceConfig?.ui?.default_locale
  if (instanceLocale) {
    const norm = instanceLocale.toLowerCase().split('-')[0]
    if (SUPPORTED_LOCALES.includes(norm as SupportedLocale)) {
      return norm as SupportedLocale
    }
  }

  // Priority 3 — browser Accept-Language header
  if (acceptLanguageHeader) {
    const fromBrowser = parseAcceptLanguage(acceptLanguageHeader)
    if (fromBrowser.length > 0) return fromBrowser[0]
  }

  return DEFAULT_LOCALE
}

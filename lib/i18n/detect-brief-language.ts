// lib/i18n/detect-brief-language.ts
// Amendment 87.1 — detect the language of a task brief without an LLM call.
//
// Uses the `franc` package (MIT, ~82 KB, 400+ languages, runs fully offline).
// Detection is best-effort:
//   - Minimum 20 characters (too short = unreliable → no banner)
//   - If franc returns 'und' (undetermined) → no banner
//   - Mismatch detection compares base locale only ('fr-FR' treated as 'fr')

import { baseLocale } from './language-names'

// franc is loaded lazily to avoid blocking startup if the package is missing.
// It will be installed as a dependency (declared in package.json).
let _franc: ((text: string, options?: { minLength?: number }) => string) | null = null

async function getFranc() {
  if (_franc) return _franc
  try {
    // franc is an ESM-only package — must be dynamically imported.
    const mod = await import('franc')
    _franc = mod.franc
    return _franc
  } catch {
    // franc not installed — detection is unavailable, no banner shown.
    return null
  }
}

export interface BriefLanguageCheck {
  /** BCP 47 base language detected in the brief. Empty string if undetermined. */
  detected: string
  /** Current project output_language for comparison. */
  configured: string
  /** True if detected ≠ configured AND detection was confident. */
  mismatch: boolean
  /** English display name of the detected language (e.g. 'Thai'). */
  language_name: string
}

/**
 * Detect the language of a task brief and compare it to the configured
 * output_language. Returns a BriefLanguageCheck result suitable for the
 * LanguageMismatchBanner.
 *
 * @param taskInput      - Raw text typed by the user as their task description
 * @param outputLanguage - BCP 47 tag of the project's output_language config
 */
export async function detectBriefLanguage(
  taskInput: string,
  outputLanguage: string,
): Promise<BriefLanguageCheck> {
  const NO_MISMATCH: BriefLanguageCheck = {
    detected: '',
    configured: outputLanguage,
    mismatch: false,
    language_name: '',
  }

  // Too short — detection is unreliable.
  if (!taskInput || taskInput.trim().length < 20) return NO_MISMATCH

  const franc = await getFranc()
  if (!franc) return NO_MISMATCH   // package not available

  const raw = franc(taskInput, { minLength: 20 })
  if (!raw || raw === 'und') return NO_MISMATCH   // undetermined

  // franc returns ISO 639-3 codes (e.g. 'tha', 'fra', 'eng').
  // Intl.DisplayNames accepts them in modern runtimes.
  const detected = raw   // keep as-is for Intl.DisplayNames

  const detectedBase = baseLocale(detected)
  const configuredBase = baseLocale(outputLanguage)

  if (detectedBase === configuredBase) return NO_MISMATCH

  // Dynamically resolve the display name to avoid a static import of a large map.
  const { getLanguageName } = await import('./language-names')
  const language_name = getLanguageName(detected)

  return {
    detected,
    configured: outputLanguage,
    mismatch: true,
    language_name,
  }
}

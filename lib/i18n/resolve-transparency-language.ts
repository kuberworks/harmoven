// lib/i18n/resolve-transparency-language.ts
// Amendment 87.4 — transparency_language resolution.
//
// Controls the language of agent progress reports shown to the user:
//   ActivityFeed descriptions, AgentDetailDrawer notes, HANDOFF_NOTE summaries.
//
// Does NOT affect:
//   - Agent system prompts (always English)
//   - Content produced by Writer agents (controlled by output_language)
//   - UI labels (controlled by ui_locale)
//
// Default: follows ui_locale automatically — zero user configuration required.
// Override: user can set transparency_language separately in Settings.

interface TransparencyUser {
  ui_locale?: string | null
  transparency_language?: string | null
}

/**
 * Resolve the language to use for transparency / progress feed messages.
 *
 * @param user             - Authenticated user record
 * @param browserLocale    - Resolved browser/session locale (from resolveUILocale)
 */
export function resolveTransparencyLanguage(
  user: TransparencyUser | null | undefined,
  browserLocale = 'en',
): string {
  // 1. Explicit user preference (rare — power users only).
  if (user?.transparency_language) {
    return user.transparency_language
  }

  // 2. Follows ui_locale automatically — zero configuration step.
  if (user?.ui_locale) {
    return user.ui_locale
  }

  // 3. Fall back to the resolved browser locale.
  return browserLocale
}

// lib/i18n/language-names.ts
// Amendment 87.3 — human-readable language names via Intl.DisplayNames.
// Always uses English display names in the banner regardless of ui_locale —
// showing "Thai" rather than "ภาษาไทย" avoids confusing non-Thai UI users.

/**
 * Return the English display name for a BCP 47 language tag.
 *
 * Examples:
 *   getLanguageName('th') → 'Thai'
 *   getLanguageName('fr') → 'French'
 *   getLanguageName('zh') → 'Chinese'
 *   getLanguageName('ar') → 'Arabic'
 *   getLanguageName('und') → 'und'   (fallback: return the code)
 */
export function getLanguageName(bcp47: string, displayLocale = 'en'): string {
  if (!bcp47 || bcp47 === 'und') return bcp47

  try {
    const displayNames = new Intl.DisplayNames([displayLocale], {
      type: 'language',
    })
    return displayNames.of(bcp47) ?? bcp47
  } catch {
    // Intl.DisplayNames may not know every BCP 47 tag — fall back to the code.
    return bcp47
  }
}

/**
 * Normalise a BCP 47 tag to two-letter base language only.
 * 'fr-FR' → 'fr'
 * 'zh-Hans-CN' → 'zh'
 */
export function baseLocale(bcp47: string): string {
  return bcp47.toLowerCase().split('-')[0]
}

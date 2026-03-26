// tests/i18n/t3.7-i18n.test.ts
// Unit tests for T3.7 i18n system (Amendment 86 / 87)
// All tests run with HARMOVEN_LLM_TIER=mock — no LLM / DB calls.

import { describe, it, expect } from '@jest/globals'

import {
  resolveUILocale,
  parseAcceptLanguage,
} from '@/lib/i18n/detect-locale'
import { resolveTransparencyLanguage } from '@/lib/i18n/resolve-transparency-language'
import { getLanguageName, baseLocale } from '@/lib/i18n/language-names'
import { createT } from '@/lib/i18n/t'

// ---------------------------------------------------------------------------
// detect-locale.ts
// ---------------------------------------------------------------------------
describe('resolveUILocale', () => {
  it('returns user preference when valid and supported', () => {
    expect(resolveUILocale(null, { ui_locale: 'fr' }, null)).toBe('fr')
  })

  it('ignores unknown user locale, falls through to instance default', () => {
    expect(
      resolveUILocale(null, { ui_locale: 'de' }, { ui: { default_locale: 'fr' } }),
    ).toBe('fr')
  })

  it('picks up instance default when user has no preference', () => {
    expect(resolveUILocale(null, null, { ui: { default_locale: 'fr' } })).toBe('fr')
  })

  it('parses Accept-Language header when no user/instance pref', () => {
    expect(resolveUILocale('fr-FR,fr;q=0.9,en;q=0.8', null, null)).toBe('fr')
  })

  it('falls back to en when nothing matches', () => {
    expect(resolveUILocale('de,ja;q=0.9', null, null)).toBe('en')
  })

  it('normalises fr-FR user locale to fr', () => {
    expect(resolveUILocale(null, { ui_locale: 'fr-FR' }, null)).toBe('fr')
  })

  it('returns en for null user and null header', () => {
    expect(resolveUILocale(null, null, null)).toBe('en')
  })
})

describe('parseAcceptLanguage', () => {
  it('returns supported locales in priority order', () => {
    const result = parseAcceptLanguage('fr-FR,fr;q=0.9,en;q=0.8')
    expect(result).toEqual(['fr', 'en'])
  })

  it('skips unsupported locales', () => {
    expect(parseAcceptLanguage('de,ja')).toEqual([])
  })

  it('handles empty string', () => {
    expect(parseAcceptLanguage('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolve-transparency-language.ts
// ---------------------------------------------------------------------------
describe('resolveTransparencyLanguage', () => {
  it('returns explicit transparency_language when set', () => {
    expect(
      resolveTransparencyLanguage({
        ui_locale: 'en',
        transparency_language: 'fr',
      }),
    ).toBe('fr')
  })

  it('follows ui_locale when no explicit transparency_language', () => {
    expect(
      resolveTransparencyLanguage({ ui_locale: 'fr', transparency_language: null }),
    ).toBe('fr')
  })

  it('falls back to browserLocale arg when no user prefs', () => {
    expect(resolveTransparencyLanguage(null, 'fr')).toBe('fr')
  })

  it('falls back to en when no user and no browserLocale', () => {
    expect(resolveTransparencyLanguage(null)).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// language-names.ts
// ---------------------------------------------------------------------------
describe('getLanguageName', () => {
  it('returns English name for fr', () => {
    expect(getLanguageName('fr')).toBe('French')
  })

  it('returns English name for en', () => {
    expect(getLanguageName('en')).toBe('English')
  })

  it('returns code as fallback for und', () => {
    expect(getLanguageName('und')).toBe('und')
  })

  it('returns code as fallback for empty string', () => {
    expect(getLanguageName('')).toBe('')
  })
})

describe('baseLocale', () => {
  it('strips region from fr-FR', () => {
    expect(baseLocale('fr-FR')).toBe('fr')
  })

  it('lowercases', () => {
    expect(baseLocale('EN')).toBe('en')
  })

  it('returns base as-is when no region', () => {
    expect(baseLocale('en')).toBe('en')
  })
})

// ---------------------------------------------------------------------------
// t.ts — translation function
// ---------------------------------------------------------------------------
describe('createT', () => {
  const tEn = createT('en')
  const tFr = createT('fr')

  it('translates a simple key in English', () => {
    expect(tEn('runs.status.running')).toBe('Running')
  })

  it('translates a simple key in French', () => {
    expect(tFr('runs.status.running')).toBe('En cours')
  })

  it('interpolates {param} placeholders', () => {
    expect(tEn('common.ago', { time: '5m' })).toBe('5m ago')
    expect(tFr('common.ago', { time: '5m' })).toBe('il y a 5m')
  })

  it('falls back to English for unknown locale', () => {
    const tDe = createT('de')
    expect(tDe('runs.status.running')).toBe('Running')
  })

  it('returns the key itself when key is not found in any locale', () => {
    expect(tEn('nonexistent.key')).toBe('nonexistent.key')
  })

  it('never returns an empty string (blank UI prevention)', () => {
    const result = tEn('nonexistent.key.deep')
    expect(result.length).toBeGreaterThan(0)
  })

  it('translates nested key in English', () => {
    expect(tEn('gates.critical.blocking')).toBe('Blocking')
  })

  it('translates nested key in French', () => {
    expect(tFr('gates.critical.blocking')).toBe('Bloquant')
  })
})

// ---------------------------------------------------------------------------
// locale JSON completeness check
// ---------------------------------------------------------------------------
describe('locale JSON completeness', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const en = require('../../locales/en.json') as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fr = require('../../locales/fr.json') as Record<string, unknown>

  function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
    const keys: string[] = []
    for (const [k, v] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${k}` : k
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        keys.push(...flatKeys(v as Record<string, unknown>, full))
      } else {
        keys.push(full)
      }
    }
    return keys
  }

  it('fr.json has all keys present in en.json', () => {
    const enKeys = flatKeys(en)
    const frKeys = new Set(flatKeys(fr))
    const missing = enKeys.filter(k => !frKeys.has(k))
    expect(missing).toEqual([])
  })

  it('en.json has more than 300 keys (completeness sanity check)', () => {
    const enKeys = flatKeys(en)
    expect(enKeys.length).toBeGreaterThan(300)
  })

  it('no [TODO-TRANSLATE] values in fr.json', () => {
    const frKeys = flatKeys(fr)
    const todo = frKeys.filter(k => {
      const parts = k.split('.')
      let val: unknown = fr
      for (const p of parts) val = (val as Record<string, unknown>)[p]
      return typeof val === 'string' && val.startsWith('[TODO-TRANSLATE]')
    })
    expect(todo).toEqual([])
  })
})

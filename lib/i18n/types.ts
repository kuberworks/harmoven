// lib/i18n/types.ts
// Amendment 86/87 — i18n type definitions

export type SupportedLocale = 'en' | 'fr'

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'fr']

export const DEFAULT_LOCALE: SupportedLocale = 'en'

/** Cookie name used to persist resolved locale across requests. */
export const LOCALE_COOKIE = 'hl'   // harmoven-locale (short to save bytes)

/** Header set by middleware for downstream server components. */
export const LOCALE_HEADER = 'x-hl-locale'

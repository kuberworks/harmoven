'use client'
// lib/i18n/client.tsx
// Amendment 86 — client-side translation context and hook.
//
// Usage:
//   1. In a Server Component layout, resolve the locale and pass it as a prop.
//   2. Wrap the subtree with <TranslationProvider locale={locale}>.
//   3. Client components call useT() to get a translation function.
//
// Example (app/layout.tsx):
//   import { TranslationProvider } from '@/lib/i18n/client'
//   <TranslationProvider locale={resolvedLocale}>{children}</TranslationProvider>

import React, { createContext, useContext, useMemo } from 'react'
import { createT, type TFunction } from './t'
import type { SupportedLocale } from './types'

const TranslationContext = createContext<TFunction | null>(null)

interface TranslationProviderProps {
  locale: SupportedLocale | string
  children: React.ReactNode
}

/**
 * Provide translations to all client components in the subtree.
 * Place this as high as possible (e.g. root layout) so all children share
 * the same translation function without redundant context lookups.
 */
export function TranslationProvider({
  locale,
  children,
}: TranslationProviderProps) {
  // Memoise so the translation function is stable across re-renders.
  const t = useMemo(() => createT(locale), [locale])

  return (
    <TranslationContext.Provider value={t}>
      {children}
    </TranslationContext.Provider>
  )
}

/**
 * Return the translation function for the current locale.
 *
 * Must be called inside a <TranslationProvider> subtree.
 * Falls back gracefully if called outside a provider (returns key).
 */
export function useT(): TFunction {
  const t = useContext(TranslationContext)
  // If for some reason the provider is absent, return a no-op t() that
  // returns the key — never crash the UI.
  return t ?? ((key: string) => key)
}

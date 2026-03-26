'use client'
// components/run/LanguageMismatchBanner.tsx
// Amendment 87.2 — role-aware language mismatch banner.
//
// Shown in the run creation flow when the detected brief language differs from
// the configured output_language.
//
// Variant A (standard user — no project:edit):
//   Informational only. No action buttons. Dismissible.
//
// Variant B (project admin/developer — has project:edit):
//   Offers [Generate in {language}] to override output_language for this run,
//   which requires project:edit permission (Am.87.2).
//
// The run-level override is stored in Run.run_config.output_language_override.
// It does NOT modify the project config and does NOT trigger a config.git commit.

import React, { useState } from 'react'
import { useT } from '@/lib/i18n/client'

interface LanguageMismatchBannerProps {
  /** English name of the detected language, e.g. 'Thai', 'French'. */
  detectedLanguageName: string
  /** BCP 47 tag of the detected language (e.g. 'th'). */
  detectedLanguageCode: string
  /** English name of the configured output language, e.g. 'English'. */
  configuredLanguageName: string
  /** Whether the caller has project:edit permission (Am.78). */
  canChangeOutputLanguage: boolean
  /**
   * Called when the user clicks [Generate in {language}].
   * The caller is responsible for setting the run-level override.
   * This callback receives the BCP 47 tag of the desired output language.
   */
  onOverride?: (languageCode: string) => void
}

/**
 * Non-blocking banner shown during run creation when the brief language
 * does not match the project's configured output_language.
 *
 * Hidden by default once dismissed. Shows once per component mount.
 */
export function LanguageMismatchBanner({
  detectedLanguageName,
  detectedLanguageCode,
  configuredLanguageName,
  canChangeOutputLanguage,
  onOverride,
}: LanguageMismatchBannerProps) {
  const t = useT()
  const [dismissed, setDismissed] = useState(false)
  const [overridden, setOverridden] = useState(false)

  if (dismissed) return null

  if (overridden) {
    // Show a brief confirmation, then auto-dismiss.
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200"
      >
        <span>
          {t('language.output_language_changed', {
            language: detectedLanguageName,
          })}
        </span>
      </div>
    )
  }

  function handleOverride() {
    onOverride?.(detectedLanguageCode)
    setOverridden(true)
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="relative flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      {/* Message */}
      <span className="flex-1">
        {t('language.mismatch_banner', {
          detected: detectedLanguageName,
          configured: configuredLanguageName,
        })}
      </span>

      {/* Variant B — project:edit: offer override */}
      {canChangeOutputLanguage && (
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleOverride}
            className="rounded bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-700"
          >
            {t('language.generate_in', { language: detectedLanguageName })}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-700 dark:text-amber-200 dark:hover:bg-amber-900"
          >
            {t('language.continue_with')}
          </button>
        </div>
      )}

      {/* Dismiss button — always present */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="absolute end-2 top-2 rounded p-1 text-amber-700 hover:bg-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-700 dark:text-amber-300 dark:hover:bg-amber-900"
      >
        {/* ×  close icon */}
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

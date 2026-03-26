'use client'

// components/admin/UpdateBanner.tsx
// Admin UI banner shown when a new Harmoven version is available.
// Spec: Amendment 88 — Docker update flow, step 3–5.
//
// Displayed in the Admin layout when GET /api/updates returns hasUpdate: true.
// Guides the admin through: changelog → backup confirm → migration preview → apply.
//
// Desktop-only concern: shown only to instance_admin in the Admin section.

import React, { useState, useCallback, useEffect } from 'react'
import type {
  UpdateCheckResult,
  MigrationPreview,
  MigrationStep,
  MigrationRisk,
  UpdateWizardStep,
} from '@/lib/updates/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpdateBannerProps {
  /** Initial update check result — passed from server component */
  updateInfo: UpdateCheckResult & { migrationPreview: MigrationPreview }
}

// ─── Risk badge ───────────────────────────────────────────────────────────────

const RISK_STYLES: Record<MigrationRisk, { bg: string; label: string }> = {
  safe:    { bg: 'bg-green-100 text-green-800',  label: 'safe'    },
  warning: { bg: 'bg-yellow-100 text-yellow-800', label: 'warning' },
  danger:  { bg: 'bg-red-100 text-red-800',       label: 'DATA LOSS' },
}

function RiskBadge({ risk }: { risk: MigrationRisk }) {
  const { bg, label } = RISK_STYLES[risk]
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${bg}`}>
      {label}
    </span>
  )
}

// ─── Migration step list ──────────────────────────────────────────────────────

function MigrationList({ steps }: { steps: MigrationStep[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  if (steps.length === 0) {
    return <p className="text-sm text-neutral-500">No pending migrations — update is safe to apply.</p>
  }

  return (
    <ul className="space-y-2 text-sm">
      {steps.map((step, idx) => (
        <li key={step.name} className="rounded-lg border border-neutral-200 bg-white">
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
            onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
            aria-expanded={expandedIdx === idx}
          >
            <RiskBadge risk={step.risk} />
            <span className="flex-1 font-mono text-xs text-neutral-700">{step.name}</span>
            <span className="text-neutral-400">{expandedIdx === idx ? '▲' : '▼'}</span>
          </button>
          {expandedIdx === idx && (
            <div className="border-t border-neutral-100 px-4 py-3">
              {step.riskReason && (
                <p className="mb-2 text-yellow-700 text-xs font-medium">{step.riskReason}</p>
              )}
              <pre className="overflow-auto rounded bg-neutral-50 p-3 text-xs text-neutral-700 max-h-48">
                {step.sql}
              </pre>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

// ─── Main banner / wizard ─────────────────────────────────────────────────────

export function UpdateBanner({ updateInfo }: UpdateBannerProps) {
  const [wizardStep, setWizardStep]     = useState<UpdateWizardStep>('available')
  const [dismissed, setDismissed]       = useState(false)
  const [applying, setApplying]         = useState(false)
  const [applyError, setApplyError]     = useState<string | null>(null)
  const [applySuccess, setApplySuccess] = useState(false)

  const { latestVersion, currentVersion, bump, changelog, migrationPreview, imageTag, imageDigest } = updateInfo

  const handleDismiss = useCallback(() => setDismissed(true), [])

  const handleApply = useCallback(async () => {
    if (!latestVersion || !imageTag || !bump) return
    setApplying(true)
    setApplyError(null)
    setWizardStep('applying')

    try {
      const res = await fetch('/api/updates/apply', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version:     latestVersion,
          imageTag:    imageTag,
          imageDigest: imageDigest ?? '',
          bump,
          confirmed:   true,
        }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string; reason?: string }
        throw new Error(data.reason ?? data.error ?? 'Update failed')
      }
      setApplySuccess(true)
      setWizardStep('done')
    } catch (e) {
      setApplyError((e as Error).message)
      setWizardStep('error')
    } finally {
      setApplying(false)
    }
  }, [latestVersion, imageTag, imageDigest, bump])

  if (dismissed || !updateInfo.hasUpdate) return null

  // ── Done state ────────────────────────────────────────────────────────────
  if (wizardStep === 'done' && applySuccess) {
    return (
      <div role="status" className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-5 py-3 text-sm text-green-800">
        <span className="text-lg">✓</span>
        <span>Harmoven {latestVersion} installed successfully. The application will restart momentarily.</span>
      </div>
    )
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (wizardStep === 'error') {
    return (
      <div role="alert" className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-5 py-3 text-sm text-red-800">
        <span className="mt-0.5 text-lg">✕</span>
        <div>
          <p className="font-semibold">Update failed</p>
          {applyError && <p className="mt-0.5 text-red-700">{applyError}</p>}
          <button
            type="button"
            className="mt-2 text-sm underline"
            onClick={() => { setWizardStep('available'); setApplyError(null) }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  // ── Applying state ────────────────────────────────────────────────────────
  if (wizardStep === 'applying') {
    return (
      <div role="status" className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-5 py-3 text-sm text-blue-800">
        <span className="animate-spin">⟳</span>
        <span>Applying update to Harmoven {latestVersion}… this may take a few minutes.</span>
      </div>
    )
  }

  // ── Migration preview step ────────────────────────────────────────────────
  if (wizardStep === 'migration_preview') {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="font-semibold text-neutral-900">Migration preview — Harmoven {latestVersion}</h2>
          <button type="button" onClick={handleDismiss} className="text-neutral-400 hover:text-neutral-600" aria-label="Dismiss">✕</button>
        </header>

        <p className="text-sm text-neutral-600">
          {migrationPreview.pending.length} pending migration{migrationPreview.pending.length !== 1 ? 's' : ''}.
          {migrationPreview.hasDataLoss && (
            <span className="ml-2 font-semibold text-red-700">⚠ One or more migrations may cause DATA LOSS.</span>
          )}
        </p>

        <MigrationList steps={migrationPreview.pending} />

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            onClick={handleApply}
            disabled={applying}
          >
            {applying ? 'Applying…' : 'Update now'}
          </button>
          <button
            type="button"
            className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            onClick={() => setWizardStep('available')}
          >
            Back
          </button>
          <button
            type="button"
            className="ml-auto text-sm text-neutral-500 hover:text-neutral-700"
            onClick={handleDismiss}
          >
            Later
          </button>
        </div>
      </div>
    )
  }

  // ── Available state (default banner) ─────────────────────────────────────
  const bumpLabel = bump === 'major' ? '🔴 Major release' : bump === 'minor' ? '🟡 Minor update' : '🟢 Patch'

  return (
    <div className="flex items-center gap-4 rounded-lg border border-blue-200 bg-blue-50 px-5 py-3 text-sm">
      <div className="flex-1">
        <span className="font-semibold text-blue-900">Harmoven {latestVersion} is available</span>
        <span className="ml-2 text-blue-600">{bumpLabel}</span>
        {bump === 'major' && (
          <span className="ml-2 text-xs text-orange-600 font-medium">(requires manual confirmation)</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {changelog && (
          <button
            type="button"
            className="rounded border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-800 hover:bg-blue-100"
            onClick={() => setWizardStep('migration_preview')}
          >
            View changelog &amp; migrations →
          </button>
        )}
        {!changelog && (
          <button
            type="button"
            className="rounded border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-800 hover:bg-blue-100"
            onClick={() => setWizardStep('migration_preview')}
          >
            Review &amp; update →
          </button>
        )}
        <button
          type="button"
          className="text-blue-500 hover:text-blue-700 text-xs"
          onClick={handleDismiss}
          aria-label="Dismiss update banner"
        >
          Later
        </button>
      </div>
    </div>
  )
}

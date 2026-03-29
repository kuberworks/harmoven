'use client'

// components/run/PauseControls.tsx
// Pause / Resume button for an active run.
// Amendment 63 — manual pause.
//
// Renders a single toggle button:
//   • RUNNING  → shows [⏸ Pause]  → calls POST /api/runs/:id/pause
//   • PAUSED   → shows [▶ Reprendre] → calls POST /api/runs/:id/resume
//
// The component is intentionally small — state changes are reflected via SSE
// which will update the run status in the parent store.

import React, { useState } from 'react'
import { useT } from '@/lib/i18n/client'

interface PauseControlsProps {
  runId: string
  /** Current run status as received from the SSE stream or initial load. */
  runStatus: 'RUNNING' | 'PAUSED' | string
  /** If true, disable interactions (e.g. while an API request is in-flight). */
  disabled?: boolean
}

export function PauseControls({ runId, runStatus, disabled = false }: PauseControlsProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()

  const isPaused  = runStatus === 'PAUSED'
  const isRunning = runStatus === 'RUNNING'

  // Only render when the run is actionable.
  if (!isPaused && !isRunning) return null

  async function handleToggle() {
    setLoading(true)
    setError(null)

    try {
      const action = isPaused ? 'resume' : 'pause'
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      // Success — parent updates via SSE; no local state to flip.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled || loading}
        aria-label={isPaused ? t('runs.actions.resume') : t('runs.actions.pause')}
        className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium
          transition-colors focus-visible:outline focus-visible:outline-2
          focus-visible:outline-offset-2 focus-visible:outline-amber-500
          disabled:cursor-not-allowed disabled:opacity-50
          ${isPaused
            ? 'bg-amber-500 text-black hover:bg-amber-400 active:bg-amber-600'
            : 'border border-surface-border bg-surface-raised text-foreground hover:border-muted-foreground hover:bg-surface-hover'
          }`}
      >
        {loading ? (
          <>
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {isPaused ? t('runs.actions.resume') + '…' : t('runs.actions.pause') + '…'}
          </>
        ) : isPaused ? (
          <>▶ {t('runs.actions.resume')}</>
        ) : (
          <>⏸ {t('runs.actions.pause')}</>
        )}
      </button>

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}

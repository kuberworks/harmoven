'use client'

// components/gate/CriticalReviewTab.tsx
// Human Gate — Critical tab (Amendment 75 / Section 27.6)
//
// Tab visibility: gates:read_critical permission (granted to operator+ roles by default).
//
// Severity badge colours:
//   blocking  → red    🔴
//   important → yellow 🟡
//   watch     → blue   🔵
//
// Actions:
//   [Fix this →]  → POST /api/runs/:runId/critical-fix   (targeted Writer agent, $0.10 cap)
//   [Ignore]      → POST /api/runs/:runId/critical-ignore  (recorded in audit log)
//   [Show all]    → calls on_show_all (reveals suppressed findings count)
//   [▲ / ▼]      → calls on_increase / decrease (reruns at severity ± 1)

import React, { useState, useCallback } from 'react'
import type {
  CriticalReviewerOutput,
  CriticalFinding,
  CriticalSeverity,
} from '@/lib/agents/reviewer/critical-reviewer.types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type UiLevel = 'GUIDED' | 'STANDARD' | 'ADVANCED'

export interface CriticalReviewTabProps {
  output:      CriticalReviewerOutput
  run_id:      string
  node_id:     string
  result_id:   string // CriticalReviewResult.id — required for fix/ignore endpoints
  ui_level:    UiLevel
  on_fix:      (finding_id: string) => void
  on_ignore:   (finding_id: string) => void
  on_show_all: () => void
  on_increase: () => void
}

// ─── Severity badge ────────────────────────────────────────────────────────────

const SEVERITY_BADGE_STYLES: Record<CriticalFinding['severity'], { bg: string; text: string; dot: string; label: string }> = {
  blocking:  { bg: 'bg-red-50 border border-red-200',    text: 'text-red-700',    dot: '🔴', label: 'Blocking'  },
  important: { bg: 'bg-amber-50 border border-amber-200', text: 'text-amber-700',  dot: '🟡', label: 'Important' },
  watch:     { bg: 'bg-blue-50 border border-blue-200',   text: 'text-blue-700',   dot: '🔵', label: 'Watch'     },
}

function SeverityBadge({ severity }: { severity: CriticalFinding['severity'] }) {
  const style = SEVERITY_BADGE_STYLES[severity] ?? SEVERITY_BADGE_STYLES['watch']
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${style.bg} ${style.text}`}>
      {style.dot} {style.label}
    </span>
  )
}

// ─── Finding card ─────────────────────────────────────────────────────────────

interface FindingCardProps {
  finding:   CriticalFinding
  run_id:    string
  result_id: string
  pending:   Set<string>
  ignored:   Set<string>
  on_fix:    (finding_id: string) => void
  on_ignore: (finding_id: string) => void
}

function FindingCard({
  finding, run_id, result_id, pending, ignored, on_fix, on_ignore,
}: FindingCardProps) {
  const [fixing,  setFixing]  = useState(false)
  const [ignoring, setIgnoring] = useState(false)
  const [fixError,  setFixError]  = useState<string | null>(null)
  const [ignError,  setIgnError]  = useState<string | null>(null)

  const isIgnored = ignored.has(finding.id)
  const isPending = pending.has(finding.id)

  const handleFix = useCallback(async () => {
    if (fixing || isPending) return
    setFixing(true)
    setFixError(null)
    try {
      const res = await fetch(`/api/runs/${run_id}/critical-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finding_id: finding.id, finding, result_id }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string }
        setFixError(json.error ?? `Error ${res.status}`)
      } else {
        on_fix(finding.id)
      }
    } catch {
      setFixError('Network error')
    } finally {
      setFixing(false)
    }
  }, [fixing, isPending, finding, run_id, result_id, on_fix])

  const handleIgnore = useCallback(async () => {
    if (ignoring || isIgnored) return
    setIgnoring(true)
    setIgnError(null)
    try {
      const res = await fetch(`/api/runs/${run_id}/critical-ignore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finding_id: finding.id, finding, result_id }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string }
        setIgnError(json.error ?? `Error ${res.status}`)
      } else {
        on_ignore(finding.id)
      }
    } catch {
      setIgnError('Network error')
    } finally {
      setIgnoring(false)
    }
  }, [ignoring, isIgnored, finding, run_id, result_id, on_ignore])

  const style = SEVERITY_BADGE_STYLES[finding.severity] ?? SEVERITY_BADGE_STYLES['watch']
  const cardBg = isIgnored ? 'opacity-50' : ''

  return (
    <article className={`rounded-lg border border-neutral-200 bg-white p-4 space-y-2 ${cardBg}`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <SeverityBadge severity={finding.severity} />
          <span className="text-xs font-medium text-neutral-500 uppercase tracking-wide">{finding.domain}</span>
        </div>
        {isIgnored && (
          <span className="text-xs text-neutral-400 italic shrink-0">Ignored</span>
        )}
      </div>

      {/* Title */}
      <h4 className="text-sm font-semibold text-neutral-900 leading-snug">{finding.title}</h4>

      {/* Observation */}
      <p className="text-sm text-neutral-700">{finding.observation}</p>

      {/* Impact */}
      <div className={`rounded px-3 py-2 text-sm ${style.bg} ${style.text}`}>
        <span className="font-semibold">Impact: </span>{finding.impact}
      </div>

      {/* Suggestion */}
      {finding.suggestion && (
        <p className="text-sm text-neutral-600">
          <span className="font-semibold">Fix: </span>{finding.suggestion}
        </p>
      )}

      {/* Error messages */}
      {fixError && <p className="text-xs text-red-600">{fixError}</p>}
      {ignError && <p className="text-xs text-red-600">{ignError}</p>}

      {/* Actions */}
      {!isIgnored && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleFix}
            disabled={fixing || isPending}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-neutral-900 text-white hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {fixing ? 'Applying…' : isPending ? 'Fix pending…' : 'Fix this →'}
          </button>

          <button
            onClick={handleIgnore}
            disabled={ignoring}
            className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {ignoring ? 'Ignoring…' : 'Ignore'}
          </button>
        </div>
      )}
    </article>
  )
}

// ─── Severity level label ──────────────────────────────────────────────────────

const SEVERITY_LABELS: Record<CriticalSeverity, string> = {
  0: 'Off',
  1: 'Lenient',
  2: 'Standard',
  3: 'Strict',
  4: 'Thorough',
  5: 'Paranoid',
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CriticalReviewTab({
  output,
  run_id,
  result_id,
  ui_level,
  on_fix,
  on_ignore,
  on_show_all,
  on_increase,
}: CriticalReviewTabProps) {
  const [pendingFixes,  setPendingFixes]  = useState<Set<string>>(new Set())
  const [ignoredIds,   setIgnoredIds]    = useState<Set<string>>(new Set())

  const handleFix = useCallback((findingId: string) => {
    setPendingFixes(prev => new Set([...prev, findingId]))
    on_fix(findingId)
  }, [on_fix])

  const handleIgnore = useCallback((findingId: string) => {
    setIgnoredIds(prev => new Set([...prev, findingId]))
    on_ignore(findingId)
  }, [on_ignore])

  const isDisabled   = output.severity === 0
  const hasFindings  = output.findings.length > 0
  const severityLabel = SEVERITY_LABELS[output.severity] ?? String(output.severity)
  const canIncrease   = output.severity < 5

  if (isDisabled) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-neutral-400 text-sm">
        <span className="text-2xl mb-2">⚪</span>
        <p>Critical Reviewer is disabled (severity = 0).</p>
        <button
          onClick={on_increase}
          className="mt-4 text-xs text-neutral-500 underline hover:text-neutral-700"
        >
          Enable (set severity to 1 — Lenient)
        </button>
      </div>
    )
  }

  return (
    <section className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">Critical Review</h3>
          <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-600 font-medium">
            Severity {output.severity} — {severityLabel}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
            output.verdict === 'no_issues'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {output.verdict === 'no_issues' ? '✓ No issues' : `⚠ ${output.findings.length} finding${output.findings.length !== 1 ? 's' : ''}`}
          </span>
        </div>

        {/* Severity controls — ADVANCED ui only */}
        {ui_level === 'ADVANCED' && canIncrease && (
          <button
            onClick={on_increase}
            title="Rerun at higher severity"
            className="text-xs text-neutral-500 hover:text-neutral-900 underline"
          >
            Increase severity ↑
          </button>
        )}
      </div>

      {/* Rationale */}
      {output.rationale && (
        <p className="text-sm text-neutral-600 italic">{output.rationale}</p>
      )}

      {/* No findings state */}
      {!hasFindings && (
        <div className="flex flex-col items-center py-8 text-neutral-400">
          <span className="text-3xl mb-2">✅</span>
          <p className="text-sm">No findings at severity level {output.severity}.</p>
          {output.suppressed > 0 && (
            <p className="text-xs mt-1">
              {output.suppressed} finding{output.suppressed !== 1 ? 's' : ''} below threshold.{' '}
              <button className="underline hover:text-neutral-600" onClick={on_show_all}>
                Show all
              </button>
            </p>
          )}
        </div>
      )}

      {/* Findings list */}
      {hasFindings && (
        <div className="space-y-3">
          {output.findings.map(finding => (
            <FindingCard
              key={finding.id}
              finding={finding}
              run_id={run_id}
              result_id={result_id}
              pending={pendingFixes}
              ignored={ignoredIds}
              on_fix={handleFix}
              on_ignore={handleIgnore}
            />
          ))}
        </div>
      )}

      {/* Suppressed notice */}
      {output.suppressed > 0 && hasFindings && (
        <p className="text-xs text-neutral-500 text-center">
          +{output.suppressed} finding{output.suppressed !== 1 ? 's' : ''} below threshold —{' '}
          <button className="underline hover:text-neutral-700" onClick={on_show_all}>
            Show all
          </button>
        </p>
      )}
    </section>
  )
}

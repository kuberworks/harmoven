'use client'

// components/gate/EvalTab.tsx
// Amendment 89 — Human Gate: Eval tab showing EvalAgent score + criteria breakdown.
//
// Renders per-criterion scores as progress bars with colour coding:
//   ≥ 0.7  → green  (pass)
//   ≥ 0.5  → amber  (borderline)
//   < 0.5  → red    (hard-fail risk)
//
// Styled with Tailwind utility classes (dark-first, amber accents).
// No shadcn/ui or Radix dependency — plain React.

import React from 'react'
import type { EvalAgentOutput, ScoredCriterion } from '@/lib/agents/eval/eval.types'

// ─── Score helpers ────────────────────────────────────────────────────────────

function scoreColour(score: number, hardFail: boolean): string {
  if (hardFail && score < 0.5) return 'text-red-400'
  if (score >= 0.7)  return 'text-emerald-400'
  if (score >= 0.5)  return 'text-amber-400'
  return 'text-red-400'
}

function barColour(score: number, hardFail: boolean): string {
  if (hardFail && score < 0.5) return 'bg-red-500'
  if (score >= 0.7)  return 'bg-emerald-500'
  if (score >= 0.5)  return 'bg-amber-500'
  return 'bg-red-500'
}

function verdictBadge(verdict: EvalAgentOutput['verdict']): { label: string; className: string } {
  switch (verdict) {
    case 'PASS':           return { label: 'Passed', className: 'bg-emerald-700 text-emerald-200' }
    case 'RETRY':          return { label: 'Retried', className: 'bg-amber-700 text-amber-200' }
    case 'ESCALATE_HUMAN': return { label: 'Human review', className: 'bg-red-800 text-red-200' }
  }
}

function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreBar({ score, hardFail }: { score: number; hardFail: boolean }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-zinc-700">
      <div
        className={`h-1.5 rounded-full transition-all ${barColour(score, hardFail)}`}
        style={{ width: pct(Math.min(1, Math.max(0, score))) }}
      />
    </div>
  )
}

function CriterionRow({ criterion }: { criterion: ScoredCriterion }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">{criterion.name}</span>
          {criterion.hard_fail && (
            <span className="rounded px-1 py-0.5 text-xs font-semibold bg-zinc-700 text-zinc-400">
              required
            </span>
          )}
        </div>
        <span className={`text-sm font-semibold tabular-nums ${scoreColour(criterion.score, criterion.hard_fail)}`}>
          {pct(criterion.score)}
        </span>
      </div>

      <ScoreBar score={criterion.score} hardFail={criterion.hard_fail} />

      {criterion.rationale && (
        <p className="text-xs text-zinc-500 leading-relaxed">{criterion.rationale}</p>
      )}

      {criterion.hard_fail && criterion.score < 0.5 && (
        <p className="text-xs text-red-400 font-medium">
          ⚠ Required criterion not met — triggered retry
        </p>
      )}
    </div>
  )
}

function OverallScoreRing({ score, passed }: { score: number; passed: boolean }) {
  const colour = passed ? 'text-emerald-400' : 'text-amber-400'
  return (
    <div className={`flex flex-col items-center justify-center rounded-xl border border-zinc-700 p-5 ${colour}`}>
      <span className="text-4xl font-bold tabular-nums">{pct(score)}</span>
      <span className="mt-1 text-xs text-zinc-500 uppercase tracking-wide">Overall score</span>
    </div>
  )
}

// ─── Attempt badge ────────────────────────────────────────────────────────────

function AttemptPip({ n, active, passed }: { n: number; active: boolean; passed: boolean }) {
  const bg = active
    ? (passed ? 'bg-emerald-500' : 'bg-amber-500')
    : 'bg-zinc-700'
  return (
    <div
      className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-zinc-900 ${bg}`}
    >
      {n}
    </div>
  )
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface EvalTabProps {
  evalOutput:    EvalAgentOutput
  /** Total attempts so far (1, 2, or 3) */
  totalAttempts: number
}

// ─── EvalTab ─────────────────────────────────────────────────────────────────

/**
 * EvalTab — Human Gate tab displaying EvalAgent quality scores.
 * Read-only: no actions are taken from this tab.
 */
export function EvalTab({ evalOutput, totalAttempts }: EvalTabProps) {
  const badge = verdictBadge(evalOutput.verdict)

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">Quality evaluation</h2>
          <p className="mt-0.5 text-sm text-zinc-500">
            Automated scoring against sprint contract criteria
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      {/* Score + attempt indicators */}
      <div className="flex items-center gap-4">
        <OverallScoreRing score={evalOutput.overall_score} passed={evalOutput.passed} />

        <div className="flex flex-col gap-2">
          <span className="text-xs text-zinc-500 uppercase tracking-wide">Attempts</span>
          <div className="flex gap-2">
            {[1, 2, 3].map(n => (
              <AttemptPip
                key={n}
                n={n}
                active={n <= totalAttempts}
                passed={n === totalAttempts && evalOutput.passed}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Criteria breakdown */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-zinc-400">Criteria breakdown</h3>
        {evalOutput.criteria.map(criterion => (
          <CriterionRow key={criterion.id} criterion={criterion} />
        ))}
      </div>

      {/* Feedback shown when not passed */}
      {evalOutput.feedback && !evalOutput.passed && (
        <div className="rounded-lg border border-amber-800 bg-amber-900/20 p-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">
            Improvement feedback
          </h3>
          <p className="text-sm text-zinc-300 leading-relaxed">{evalOutput.feedback}</p>
        </div>
      )}

      {/* Escalation notice */}
      {evalOutput.verdict === 'ESCALATE_HUMAN' && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-400">
            Human review required
          </h3>
          <p className="text-sm text-zinc-300">
            Quality score did not meet the threshold after {totalAttempts} attempt{totalAttempts !== 1 ? 's' : ''}.
            Review the criteria above and decide whether to approve or reject.
          </p>
        </div>
      )}

      {/* LLM meta (collapsed footer) */}
      <details className="text-xs text-zinc-600">
        <summary className="cursor-pointer">Evaluation metadata</summary>
        <div className="mt-2 grid grid-cols-2 gap-1">
          <span>Model</span>       <span className="text-zinc-400">{evalOutput.meta.llm_used}</span>
          <span>Tokens in</span>   <span className="text-zinc-400">{evalOutput.meta.tokens_input}</span>
          <span>Tokens out</span>  <span className="text-zinc-400">{evalOutput.meta.tokens_output}</span>
          <span>Duration</span>    <span className="text-zinc-400">{evalOutput.meta.duration_seconds}s</span>
        </div>
      </details>
    </div>
  )
}

export default EvalTab

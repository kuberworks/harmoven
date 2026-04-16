'use client'

// components/run/ContextInjectionPanel.tsx
// Panel to inject a context note into a RUNNING or PAUSED run.
// Amendment 64 — user context injection.
//
// Rendered in expert mode only (parent must gate by transparency_mode or role).
// Available when run is RUNNING or PAUSED.
//
// Calls POST /api/runs/:id/inject with { content: string }.

import React, { useState, useRef, useId } from 'react'
import { useT } from '@/lib/i18n/client'

interface ContextInjectionPanelProps {
  runId: string
  /** Current run status — panel is only shown when RUNNING or PAUSED. */
  runStatus: string
  /** Called after a successful injection so parents can reflect the new injection. */
  onInjected?: (injection: { id: string; content: string; created_at: string }) => void
}

const MAX_CHARS = 2000

export function ContextInjectionPanel({ runId, runStatus, onInjected }: ContextInjectionPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const labelId = useId()
  const t = useT()

  const isActive = runStatus === 'RUNNING' || runStatus === 'PAUSED'
  if (!isActive) return null

  const charCount = content.length
  const overLimit = charCount > MAX_CHARS

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim() || overLimit || loading) return

    setLoading(true)
    setError(null)
    setSuccessMsg(null)

    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim() }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }

      const { injection } = await res.json() as { injection: { id: string; content: string; created_at: string } }
      setContent('')
      setExpanded(false)
      setSuccessMsg(t('context.inject_success'))
      onInjected?.(injection)
      setTimeout(() => setSuccessMsg(null), 4000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!expanded) {
    return (
      <div className="flex flex-col items-start gap-1">
        <button
          type="button"
          onClick={() => {
            setExpanded(true)
            setError(null)
            setTimeout(() => textareaRef.current?.focus(), 50)
          }}
          className="inline-flex items-center gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-1.5 text-sm text-foreground hover:border-muted-foreground hover:bg-surface-hover transition-colors"
        >
          + {t('runs.actions.inject_context')}
        </button>
        {successMsg && (
          <p role="status" className="text-xs text-emerald-400">{successMsg}</p>
        )}
      </div>
    )
  }

  function handleFormKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target instanceof HTMLTextAreaElement) {
      e.preventDefault()
      e.currentTarget.requestSubmit()
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleFormKeyDown}
      aria-labelledby={labelId}
      className="flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-raised/60 p-4"
    >
      <label id={labelId} className="text-sm font-medium text-foreground">
        {t('context.inject_title')}
      </label>
      <p className="text-xs text-muted-foreground">
        {t('context.inject_hint')}
      </p>

      <textarea
        ref={textareaRef}
        value={content}
        onChange={e => setContent(e.target.value)}
        rows={4}
        maxLength={MAX_CHARS + 1} // allow one extra char so overLimit triggers
        placeholder={t('context.inject_placeholder')}
        aria-describedby={overLimit ? `${labelId}-limit` : undefined}
        className={`w-full resize-y rounded-md border bg-surface-base p-2 text-sm text-foreground
          placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring
          ${overLimit ? 'border-destructive' : 'border-surface-border'}`}
      />

      <div className="flex items-center justify-between gap-2">
        <span
          id={overLimit ? `${labelId}-limit` : undefined}
          className={`text-xs ${overLimit ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {charCount} / {MAX_CHARS}
        </span>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => { setExpanded(false); setError(null); setContent('') }}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!content.trim() || overLimit || loading}
            className="inline-flex items-center gap-2 rounded-md bg-amber-500 px-3 py-1.5
              text-sm font-medium text-black hover:bg-amber-400 active:bg-amber-600
              disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            {loading ? (
              <>
                <span className="inline-block h-3 w-3 animate-spin rounded-full
                  border-2 border-current border-t-transparent" />
                {t('common.saving')}
              </>
            ) : (
              t('context.inject_submit')
            )}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-400">{error}</p>
      )}
    </form>
  )
}

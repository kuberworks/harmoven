'use client'
// components/project/ConfigHistory.tsx
// Config History panel — Project Settings → Advanced → Config History.
// Amendment 83 (Section 83.8).
//
// Shows the git version history of a project's config files.
// Allows viewing side-by-side diffs and restoring to a previous version.
//
// Access control (83.10 rule 4):
//   - Visible only if caller has project:edit permission (enforced server-side).
//   - This component trusts the API to enforce permissions — it does not
//     implement its own RBAC checks.
//
// Note: UI uses plain HTML + Tailwind-compatible classes.
// Phase 3 (T3.1) will refactor into the full design system tokens.

import React, { useState, useEffect, useCallback } from 'react'

// ─── Types (mirrors IConfigStore / ConfigVersion) ─────────────────────────────

interface ConfigVersion {
  hash:      string
  message:   string
  author:    string
  timestamp: string   // ISO-8601 from JSON
  changed:   string[]
}

interface ConfigDiff {
  before: string
  after:  string
  patch:  string
}

interface ConfigHistoryProps {
  projectId: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en', {
    month: 'short', day: 'numeric',
    hour:  '2-digit', minute: '2-digit',
  })
}

function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DiffView({ diff, onClose }: { diff: ConfigDiff; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-surface-overlay rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold text-foreground">Config diff</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close diff view">✕</button>
        </div>
        <div className="flex flex-1 overflow-hidden divide-x">
          <div className="flex-1 overflow-auto p-4">
            <p className="text-xs font-medium text-muted-foreground mb-2">Before</p>
            <pre className="text-xs font-mono whitespace-pre-wrap text-foreground">
              {diff.before || '(empty)'}
            </pre>
          </div>
          <div className="flex-1 overflow-auto p-4">
            <p className="text-xs font-medium text-muted-foreground mb-2">After</p>
            <pre className="text-xs font-mono whitespace-pre-wrap text-foreground">
              {diff.after || '(empty)'}
            </pre>
          </div>
        </div>
        <div className="p-4 border-t">
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Raw unified diff</summary>
            <pre className="mt-2 font-mono whitespace-pre-wrap bg-surface-base p-2 rounded">
              {diff.patch || '(no changes)'}
            </pre>
          </details>
        </div>
      </div>
    </div>
  )
}

function RestoreConfirmModal({
  version,
  onConfirm,
  onCancel,
  loading,
}: {
  version:   ConfigVersion
  onConfirm: () => void
  onCancel:  () => void
  loading:   boolean
}) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-surface-overlay rounded-lg shadow-xl max-w-md w-full p-6">
        <h3 className="font-semibold text-foreground mb-2">Restore config?</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Restore config from{' '}
          <strong>{formatDate(version.timestamp)}</strong>?
          <br />
          This will create a new commit reverting to that version.
          Current config will not be lost — it stays in history.
        </p>
        <p className="text-xs text-muted-foreground mb-6 font-mono">
          Commit: {shortHash(version.hash)} — {version.message}
        </p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm rounded border border-surface-border hover:bg-surface-base disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
          >
            {loading ? 'Restoring…' : 'Confirm restore'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ConfigHistory({ projectId }: ConfigHistoryProps) {
  const [versions, setVersions]       = useState<ConfigVersion[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [diffData, setDiffData]       = useState<ConfigDiff | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<ConfigVersion | null>(null)
  const [restoring, setRestoring]     = useState(false)
  const [successMsg, setSuccessMsg]   = useState<string | null>(null)

  // Load history on mount
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/projects/${encodeURIComponent(projectId)}/config/history`)
      .then(r => r.json())
      .then((data: ConfigVersion[]) => {
        if (!cancelled) setVersions(data)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load config history.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [projectId])

  // Load diff between a version and HEAD
  const handleViewDiff = useCallback(async (version: ConfigVersion) => {
    try {
      const res  = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/config/diff?from=${version.hash}&to=HEAD`,
      )
      const data: ConfigDiff = await res.json()
      setDiffData(data)
    } catch {
      setError('Failed to load diff.')
    }
  }, [projectId])

  // Restore to a previous version
  const handleConfirmRestore = useCallback(async () => {
    if (!restoreTarget) return
    setRestoring(true)
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/config/restore`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ hash: restoreTarget.hash }),
        },
      )
      if (!res.ok) throw new Error(await res.text())
      setSuccessMsg(`Restored to ${shortHash(restoreTarget.hash)} — new commit created.`)
      setRestoreTarget(null)
      // Reload history
      const updated = await fetch(`/api/projects/${encodeURIComponent(projectId)}/config/history`)
      setVersions(await updated.json())
    } catch (err) {
      setError(`Restore failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRestoring(false)
    }
  }, [projectId, restoreTarget])

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">Loading history…</div>
  }

  if (error) {
    return (
      <div className="text-sm text-red-500 py-4">
        {error}
        <button className="ml-2 underline" onClick={() => setError(null)}>Dismiss</button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold text-foreground mb-4">Config History</h2>

      {successMsg && (
        <div className="text-sm text-green-600 bg-green-50 px-3 py-2 rounded mb-4 flex justify-between">
          {successMsg}
          <button onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}

      {versions.length === 0 && (
        <p className="text-sm text-muted-foreground">No config changes recorded yet.</p>
      )}

      <div className="divide-y rounded border">
        {versions.map(version => (
          <div key={version.hash} className="flex items-start gap-3 p-3 hover:bg-surface-hover">
            {/* Dot */}
            <div className="mt-1.5 h-2 w-2 rounded-full bg-blue-400 flex-shrink-0" />

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs text-muted-foreground">{shortHash(version.hash)}</span>
                <span className="text-sm text-foreground truncate">{version.message}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {formatDate(version.timestamp)}
                {version.changed.length > 0 && (
                  <span className="ml-2 text-muted-foreground">
                    · {version.changed.join(', ')}
                  </span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={() => handleViewDiff(version)}
                className="text-xs text-blue-500 hover:underline"
              >
                View diff
              </button>
              <button
                onClick={() => setRestoreTarget(version)}
                className="text-xs text-amber-500 hover:underline"
              >
                Restore
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Modals */}
      {diffData && (
        <DiffView diff={diffData} onClose={() => setDiffData(null)} />
      )}
      {restoreTarget && (
        <RestoreConfirmModal
          version={restoreTarget}
          onConfirm={handleConfirmRestore}
          onCancel={() => setRestoreTarget(null)}
          loading={restoring}
        />
      )}
    </div>
  )
}

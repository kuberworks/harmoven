'use client'

// components/project/ApiKeyPanel.tsx
// API key management panel — Amendment 78, Am.42.10
//
// Features:
//   - List existing keys (never shows key_hash or raw value)
//   - Create a new key: pick role, label, optional expiry
//   - Revoke a key (soft-delete)
//   - Raw key displayed ONCE upon creation in a copy-to-clipboard field
//
// Styled with Tailwind utility classes (dark-first, amber accents).
// No shadcn/ui or Radix dependency — plain React.

import React, { useState, useEffect, useCallback } from 'react'

interface RoleOption {
  id:           string
  name:         string
  display_name: string
  is_builtin:   boolean
}

interface ApiKeyRow {
  id:         string
  name:       string
  created_at: string
  created_by: string
  last_used:  string | null
  expires_at: string | null
  revoked_at: string | null
  role:       { id: string; name: string; display_name: string }
}

export interface ApiKeyPanelProps {
  projectId: string
}

// ─── Sub-component: one key row ──────────────────────────────────────────────

function KeyRow({
  k,
  onRevoke,
}: {
  k:        ApiKeyRow
  /** Called with the keyId; parent handles the DELETE fetch and state update. */
  onRevoke: (id: string) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [revoking,   setRevoking]   = useState(false)

  const revoked  = !!k.revoked_at
  const expired  = !!k.expires_at && new Date(k.expires_at) < new Date()
  const inactive = revoked || expired

  async function handleRevoke() {
    setRevoking(true)
    try {
      await onRevoke(k.id)
    } finally {
      setRevoking(false)
      setConfirming(false)
    }
  }

  return (
    <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-sm ${inactive ? 'border-zinc-700 bg-zinc-800/50 opacity-60' : 'border-zinc-700 bg-zinc-800'}`}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="font-medium text-zinc-100 truncate">{k.name}</span>
        <span className="text-xs text-zinc-500">
          Role: <span className="text-zinc-400">{k.role.display_name}</span>
          {k.expires_at && (
            <> · Expires: <span className={expired ? 'text-red-400' : 'text-zinc-400'}>{new Date(k.expires_at).toLocaleDateString()}</span></>
          )}
          {k.last_used && (
            <> · Last used: <span className="text-zinc-400">{new Date(k.last_used).toLocaleDateString()}</span></>
          )}
          {revoked && <> · <span className="text-red-400">Revoked</span></>}
          {expired && !revoked && <> · <span className="text-amber-400">Expired</span></>}
        </span>
      </div>

      {!inactive && (
        confirming ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-red-400">Revoke this key?</span>
            <button
              onClick={handleRevoke}
              disabled={revoking}
              className="rounded px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white disabled:opacity-50"
            >
              {revoking ? 'Revoking…' : 'Yes, revoke'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="flex-shrink-0 rounded px-2 py-1 text-xs border border-red-700/50 text-red-400 hover:bg-red-900/30 transition-colors"
          >
            Revoke
          </button>
        )
      )}
    </div>
  )
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export function ApiKeyPanel({ projectId }: ApiKeyPanelProps) {
  const [keys,       setKeys]       = useState<ApiKeyRow[]>([])
  const [roles,      setRoles]      = useState<RoleOption[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)

  // Create-form state
  const [keyName,    setKeyName]    = useState('')
  const [roleId,     setRoleId]     = useState('')
  const [expiresAt,  setExpiresAt]  = useState('')
  const [creating,   setCreating]   = useState(false)
  const [createErr,  setCreateErr]  = useState<string | null>(null)
  const [newRawKey,  setNewRawKey]  = useState<string | null>(null)
  const [copied,     setCopied]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [keysRes, rolesRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/api-keys`),
        fetch(`/api/projects/${projectId}/roles`),
      ])
      if (!keysRes.ok || !rolesRes.ok) throw new Error('Failed to load')
      const keysData  = await keysRes.json()  as { keys: ApiKeyRow[] }
      const rolesData = await rolesRes.json() as { roles: RoleOption[] }
      setKeys(keysData.keys)
      setRoles(rolesData.roles)
      if (rolesData.roles.length > 0 && !roleId) {
        setRoleId(rolesData.roles[0]!.id)
      }
    } catch {
      setError('Failed to load API keys.')
    } finally {
      setLoading(false)
    }
  }, [projectId, roleId])

  useEffect(() => { void load() }, [load])

  async function handleRevoke(keyId: string): Promise<void> {
    const res = await fetch(`/api/projects/${projectId}/api-keys/${keyId}`, { method: 'DELETE' })
    if (res.ok || res.status === 404) {
      setKeys((prev) => prev.map((k) => k.id === keyId ? { ...k, revoked_at: new Date().toISOString() } : k))
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreateErr(null)
    if (!keyName.trim()) { setCreateErr('Name is required.'); return }
    if (!roleId)         { setCreateErr('Select a role.'); return }

    setCreating(true)
    try {
      const body: Record<string, unknown> = {
        name:    keyName.trim(),
        role_id: roleId,
      }
      if (expiresAt) body.expires_at = new Date(expiresAt).toISOString()

      const res = await fetch(`/api/projects/${projectId}/api-keys`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        setCreateErr(data.error ?? `Error ${res.status}`)
        return
      }

      const data = await res.json() as { key: { id: string; name: string; raw_key: string; role: { id: string; name: string }; created_at: string; expires_at: string | null } }
      setNewRawKey(data.key.raw_key)
      setKeys((prev) => [
        {
          id:         data.key.id,
          name:       data.key.name,
          created_at: data.key.created_at,
          created_by: '',
          last_used:  null,
          expires_at: data.key.expires_at,
          revoked_at: null,
          role:       { id: data.key.role.id, name: data.key.role.name, display_name: data.key.role.name },
        },
        ...prev,
      ])
      setKeyName('')
      setExpiresAt('')
    } catch {
      setCreateErr('Network error — please try again.')
    } finally {
      setCreating(false)
    }
  }

  async function copyKey() {
    if (!newRawKey) return
    try {
      await navigator.clipboard.writeText(newRawKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
    } catch {
      // fallback — do nothing, user can manually select/copy
    }
  }

  return (
    <div className="space-y-6">
      {/* One-time key reveal */}
      {newRawKey && (
        <div className="rounded-lg border border-amber-600 bg-amber-900/20 p-4 space-y-2">
          <p className="text-sm font-semibold text-amber-300">
            ⚠ Copy your API key now — it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm font-mono text-zinc-100 break-all select-all">
              {newRawKey}
            </code>
            <button
              onClick={copyKey}
              className="flex-shrink-0 rounded px-3 py-2 text-xs bg-amber-700 hover:bg-amber-600 text-white transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => setNewRawKey(null)}
            className="text-xs text-zinc-500 hover:text-zinc-300 underline"
          >
            I have saved it, dismiss
          </button>
        </div>
      )}

      {/* Create new key form */}
      <form
        onSubmit={handleCreate}
        className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-4"
        aria-label="Create API key"
      >
        <h3 className="text-sm font-semibold text-zinc-100">Create new API key</h3>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="block text-xs text-zinc-400 uppercase tracking-wide" htmlFor="key-name">
              Label
            </label>
            <input
              id="key-name"
              type="text"
              required
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="e.g. CI pipeline"
              maxLength={128}
              className="w-full rounded-md bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs text-zinc-400 uppercase tracking-wide" htmlFor="key-role">
              Role
            </label>
            <select
              id="key-role"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              className="w-full rounded-md bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.display_name}{r.is_builtin ? '' : ' (custom)'}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1 sm:col-span-2">
            <label className="block text-xs text-zinc-400 uppercase tracking-wide" htmlFor="key-expires">
              Expires (optional)
            </label>
            <input
              id="key-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              min={new Date(Date.now() + 86_400_000).toISOString().split('T')[0]}
              className="w-full rounded-md bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
        </div>

        {createErr && (
          <p className="rounded-md bg-red-900/40 border border-red-700 px-3 py-2 text-sm text-red-300">
            {createErr}
          </p>
        )}

        <button
          type="submit"
          disabled={creating}
          className="rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-zinc-900 transition-colors"
        >
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {/* Key list */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-zinc-300">Existing keys</h3>

        {loading && <p className="text-sm text-zinc-500">Loading…</p>}
        {error   && <p className="text-sm text-red-400">{error}</p>}

        {!loading && keys.length === 0 && (
          <p className="text-sm text-zinc-500">No API keys yet.</p>
        )}

        {keys.map((k) => (
          <KeyRow
            key={k.id}
            k={k}
            onRevoke={handleRevoke}
          />
        ))}
      </div>
    </div>
  )
}

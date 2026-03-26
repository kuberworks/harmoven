'use client'

// components/project/RoleBuilder.tsx
// Custom role builder UI — Amendment 78, Tab visibility §28.5
//
// Allows project admins (project:members) to create custom roles by:
//   1. Choosing a built-in role to extend (inherits all its permissions)
//   2. Selecting additional permissions to add on top
//   3. Giving the role a name and display label
//
// Styled with Tailwind utility classes (dark-first, amber accents).
// No shadcn/ui or Radix dependency — plain React.

import React, { useState } from 'react'
import type { Permission } from '@/lib/auth/permissions'
import { ALL_PERMISSIONS } from '@/lib/auth/permissions'

const BUILTIN_ROLE_OPTIONS = [
  { value: 'viewer',          label: 'Viewer' },
  { value: 'operator',        label: 'Operator' },
  { value: 'user',            label: 'User' },
  { value: 'user_with_costs', label: 'User with Costs' },
  { value: 'developer',       label: 'Developer' },
  { value: 'admin',           label: 'Admin' },
] as const

// Group permissions by prefix for a cleaner UI
const PERMISSION_GROUPS: { label: string; perms: Permission[] }[] = [
  {
    label: 'Runs',
    perms: ['runs:create', 'runs:read', 'runs:read_costs', 'runs:abort', 'runs:replay', 'runs:inject', 'runs:pause'],
  },
  {
    label: 'Gates',
    perms: ['gates:read', 'gates:approve', 'gates:read_code', 'gates:read_critical'],
  },
  {
    label: 'Project',
    perms: ['project:read', 'project:edit', 'project:members', 'project:credentials'],
  },
  {
    label: 'Streams',
    perms: ['stream:state', 'stream:gates', 'stream:costs', 'stream:project'],
  },
  {
    label: 'Marketplace',
    perms: ['marketplace:install'],
  },
  {
    label: 'Admin',
    perms: ['admin:models', 'admin:skills', 'admin:users', 'admin:triggers', 'admin:audit', 'admin:instance'],
  },
]

export interface RoleBuilderProps {
  projectId: string
  /** Called after a role is successfully created — receives the new role id. */
  onCreated?: (roleId: string) => void
}

export function RoleBuilder({ projectId, onCreated }: RoleBuilderProps) {
  const [name,        setName]        = useState('')
  const [displayName, setDisplayName] = useState('')
  const [extendsRole, setExtendsRole] = useState<string>('viewer')
  const [extraPerms,  setExtraPerms]  = useState<Set<Permission>>(new Set())
  const [submitting,  setSubmitting]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [created,     setCreated]     = useState(false)

  function togglePerm(perm: Permission) {
    setExtraPerms((prev) => {
      const next = new Set(prev)
      if (next.has(perm)) next.delete(perm)
      else next.add(perm)
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Client-side validation mirrors server-side
    if (!/^[a-z0-9_]{1,64}$/.test(name)) {
      setError('Name must be lowercase letters, digits, or underscores (max 64 chars).')
      return
    }
    if (!displayName.trim()) {
      setError('Display name is required.')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/roles`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          display_name: displayName.trim(),
          extends:      extendsRole,
          permissions:  Array.from(extraPerms),
        }),
      })

      if (!res.ok) {
        const data = await res.json() as { error?: string }
        setError(data.error ?? `Error ${res.status}`)
        return
      }

      const data = await res.json() as { role: { id: string } }
      setCreated(true)
      onCreated?.(data.role.id)
    } catch {
      setError('Network error — please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    return (
      <div className="rounded-lg border border-emerald-700 bg-emerald-900/30 p-4 text-emerald-300 text-sm">
        Role <strong>{displayName}</strong> created successfully.
        <button
          className="ml-3 underline text-emerald-400 hover:text-emerald-200"
          onClick={() => { setCreated(false); setName(''); setDisplayName(''); setExtraPerms(new Set()) }}
        >
          Create another
        </button>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-5 rounded-lg border border-zinc-700 bg-zinc-900 p-5"
      aria-label="Create custom role"
    >
      <h3 className="text-base font-semibold text-zinc-100">New custom role</h3>

      {/* Name / slug */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wide" htmlFor="role-name">
          Role name (slug)
        </label>
        <input
          id="role-name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. senior_reviewer"
          pattern="^[a-z0-9_]{1,64}$"
          className="w-full rounded-md bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
        />
      </div>

      {/* Display name */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wide" htmlFor="role-display">
          Display name
        </label>
        <input
          id="role-display"
          type="text"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Senior Reviewer"
          maxLength={128}
          className="w-full rounded-md bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500"
        />
      </div>

      {/* Extends */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wide" htmlFor="role-extends">
          Extends (inherits all permissions from)
        </label>
        <select
          id="role-extends"
          value={extendsRole}
          onChange={(e) => setExtendsRole(e.target.value)}
          className="w-full rounded-md bg-zinc-800 border border-zinc-600 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
        >
          {BUILTIN_ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Extra permissions */}
      <div className="space-y-3">
        <p className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
          Additional permissions (on top of extended role)
        </p>
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="text-xs text-zinc-500 mb-1">{group.label}</p>
            <div className="flex flex-wrap gap-2">
              {group.perms.map((perm) => {
                const checked = extraPerms.has(perm)
                return (
                  <label
                    key={perm}
                    className={`flex items-center gap-1.5 cursor-pointer rounded px-2 py-1 text-xs border transition-colors ${
                      checked
                        ? 'border-amber-600 bg-amber-900/40 text-amber-200'
                        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePerm(perm)}
                      className="sr-only"
                    />
                    <span>{perm}</span>
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p className="rounded-md bg-red-900/40 border border-red-700 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-zinc-900 transition-colors"
      >
        {submitting ? 'Creating…' : 'Create role'}
      </button>
    </form>
  )
}

'use client'

// app/(app)/members/members-search-client.tsx
// Search-first member lookup.
// Results appear from MIN_CHARS characters — no full list is ever shown.

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Search, Loader2, UserX } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils/cn'

const MIN_CHARS    = 3
const DEBOUNCE_MS  = 250

interface Membership {
  project: { id: string; name: string }
  role:    { display_name: string | null; name: string }
}

interface UserResult {
  id:                  string
  name:                string
  email:               string
  role:                string | null
  project_memberships: Membership[]
}

interface Props {
  /** Whether the viewing user is instance_admin (shows admin-level links) */
  isInstanceAdmin: boolean
}

export function MembersSearchClient({ isInstanceAdmin }: Props) {
  const [query,   setQuery]   = useState('')
  const [results, setResults] = useState<UserResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)

    if (query.trim().length < MIN_CHARS) {
      setResults(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)

    timerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/members/search?q=${encodeURIComponent(query.trim())}`,
          { headers: { 'Accept': 'application/json' } },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { results: UserResult[] }
        setResults(data.results)
      } catch {
        setError('Search failed — please try again.')
        setResults(null)
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [query])

  const trimmed = query.trim()
  const belowMin = trimmed.length > 0 && trimmed.length < MIN_CHARS

  return (
    <div className="space-y-4">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          autoFocus
          type="search"
          placeholder="Search by name or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* States */}
      {!trimmed && (
        <p className="text-sm text-muted-foreground text-center py-10">
          Type at least {MIN_CHARS} characters to search.
        </p>
      )}

      {belowMin && (
        <p className="text-sm text-muted-foreground text-center py-6">
          {MIN_CHARS - trimmed.length} more character{MIN_CHARS - trimmed.length > 1 ? 's' : ''}…
        </p>
      )}

      {error && (
        <p className="text-sm text-red-400 text-center py-4">{error}</p>
      )}

      {results !== null && !loading && results.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <UserX className="h-7 w-7 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No members found for <strong className="text-foreground">"{trimmed}"</strong>.
          </p>
        </div>
      )}

      {results !== null && results.length > 0 && (
        <div className="divide-y divide-surface-border rounded-card border border-surface-border">
          {results.map((user) => (
            <div key={user.id} className="px-4 py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-foreground">
                  <Highlight text={user.name} query={trimmed} />
                </span>
                {user.role === 'instance_admin' && (
                  <Badge variant="secondary" className="text-xs">instance admin</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                <Highlight text={user.email} query={trimmed} />
              </p>

              {/* Project memberships */}
              {user.project_memberships.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {user.project_memberships.map((m) => (
                    <Link
                      key={m.project.id}
                      href={`/projects/${m.project.id}/members`}
                      className="inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface-hover px-2 py-0.5 text-xs text-foreground hover:border-muted-foreground transition-colors"
                    >
                      <span className="font-medium">{m.project.name}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">
                        {m.role.display_name ?? m.role.name}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground italic">No project memberships</p>
              )}

              {isInstanceAdmin && (
                <div className="mt-1.5">
                  <Link
                    href="/admin/users"
                    className="text-xs text-muted-foreground hover:text-[var(--accent-amber-9)] transition-colors"
                  >
                    Manage account →
                  </Link>
                </div>
              )}
            </div>
          ))}

          <div className="px-4 py-2 text-xs text-muted-foreground bg-surface-raised/50 rounded-b-card">
            Showing up to 10 results. Refine your search to narrow down.
          </div>
        </div>
      )}
    </div>
  )
}

/** Highlight matching substring in text */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className={cn(
        'bg-[var(--accent-amber-3)] text-[var(--accent-amber-11)]',
        'rounded-[2px] px-[1px]',
      )}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  )
}

'use client'

// app/(app)/admin/audit/audit-client.tsx
// Client-side filter + pagination for audit log table.

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ClipboardList, Search, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'

export interface AuditEntry {
  id: string
  timestamp: string
  runId: string | null
  nodeId: string | null
  actor: string
  actionType: string
  payload: Record<string, unknown> | null
}

interface Props {
  entries: AuditEntry[]
}

const PAGE_SIZE = 25

function ActionBadge({ type }: { type: string }) {
  const hi = type.startsWith('run.') ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
    : type.startsWith('node.') ? 'bg-violet-500/15 text-violet-400 border-violet-500/30'
    : type.startsWith('security.') ? 'bg-red-500/15 text-red-400 border-red-500/30'
    : type.startsWith('config.') ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
    : 'bg-surface-border/50 text-muted-foreground border-surface-border'
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-mono font-medium ${hi}`}>
      {type}
    </span>
  )
}

function formatTs(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('en', {
    month:  'short',
    day:    'numeric',
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function AuditClient({ entries }: Props) {
  const [query, setQuery] = useState('')
  const [page, setPage]   = useState(0)

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.actionType.toLowerCase().includes(q) ||
        e.actor.toLowerCase().includes(q) ||
        (e.runId ?? '').toLowerCase().includes(q) ||
        (e.nodeId ?? '').toLowerCase().includes(q),
    )
  }, [entries, query])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const visible    = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  function handleQuery(v: string) {
    setQuery(v)
    setPage(0)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-muted-foreground" aria-hidden />
            Audit log
            <Badge variant="secondary" className="text-xs">{filtered.length}</Badge>
          </span>
          <div className="relative w-52">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => handleQuery(e.target.value)}
              placeholder="Filter by actor, action…"
              className="pl-8 h-8 text-xs"
            />
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <ClipboardList className="h-7 w-7 text-muted-foreground/30" aria-hidden />
            <p className="text-sm text-muted-foreground">No entries match your filter.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-border text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap">Timestamp</th>
                  <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap">Actor</th>
                  <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap">Action</th>
                  <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap">Run / Node</th>
                  <th className="px-4 py-2.5 text-left font-medium whitespace-nowrap">Payload</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {visible.map((e) => (
                  <tr key={e.id} className="hover:bg-surface-hover transition-colors">
                    <td className="px-4 py-2.5 text-muted-foreground font-mono whitespace-nowrap">
                      {formatTs(e.timestamp)}
                    </td>
                    <td className="px-4 py-2.5 max-w-[140px] truncate">
                      <code className="font-mono">{e.actor}</code>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <ActionBadge type={e.actionType} />
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground font-mono">
                      {e.runId ? (
                        <Link
                          href={`/runs/${e.runId}`}
                          className="hover:text-foreground underline underline-offset-2 inline-flex items-center gap-1"
                        >
                          {e.runId.slice(0, 8)}…
                          <ExternalLink className="h-3 w-3" />
                        </Link>
                      ) : '—'}
                      {e.nodeId && (
                        <span className="ml-1 text-muted-foreground/60">({e.nodeId.slice(0, 6)}…)</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 max-w-xs">
                      {e.payload ? (
                        <code className="text-[10px] text-muted-foreground line-clamp-1">
                          {JSON.stringify(e.payload)}
                        </code>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-surface-border">
            <span className="text-xs text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                aria-label="Next page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
